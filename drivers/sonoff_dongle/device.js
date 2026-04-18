'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
const { readAttrCatch } = require('../../lib/errorUtils');
const { SONOFF_DONGLE_HEARTBEAT_MS } = require('../../lib/constants');
const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');

class SonoffDongleDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.log('Sonoff Dongle init:', this.getName());

    // Migrate existing paired devices: add is_availability if missing
    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    // Passive availability watchdog — install FIRST so ZCL responses during
    // readAttributes and configureReporting below update last_seen_ts.
    // Timeout = 15 min = 3× the 5 min reporting interval.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: SONOFF_DONGLE_HEARTBEAT_MS,
    });
    await this._availability.install();

    // Read basic attributes once to confirm communication on first contact.
    await zclNode.endpoints[1].clusters.basic
      .readAttributes(['manufacturerName', 'modelId', 'appVersion'])
      .then(attrs => this.log('[basic]', attrs))
      .catch(readAttrCatch(this, '[basic] readAttributes', { markOffline: true }));

    // Silence ZCL time cluster frames.
    try { zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster()); } catch {}

    // Configure onOff reporting — maxInterval 300s (5 min) so the device sends
    // periodic frames even when idle. These frames are caught by handleFrame to
    // keep last_seen_ts fresh. Must be configured on every init (re-pair resets it).
    try {
      await zclNode.endpoints[1].clusters.onOff.configureReporting({
        minInterval: 0,
        maxInterval: 300,
        minChange: 0,
      });
      this.log('onOff reporting configured (max 300s)');
    } catch (e) {
      this.log('onOff reporting config failed — using ping fallback:', e.message);
      // Fallback: periodic ping so handleFrame still fires every 10 min.
      this._pingInterval = this.homey.setInterval(async () => {
        zclNode.endpoints[1].clusters.basic
          .readAttributes(['zclVersion'])
          .catch(() => {});
      }, 10 * 60 * 1000);
    }
  }

  onEndDeviceAnnounce() {
    this.log('Rejoined — availability will be restored via handleFrame');
  }

  onDeleted() {
    if (this._pingInterval) this.homey.clearInterval(this._pingInterval);
    this._availability?.uninstall().catch(() => {});
    this.log('Sonoff Dongle removed');
  }

  async onBecameAvailable() {
    this.log('Device became available');
    if (super.onBecameAvailable) await super.onBecameAvailable();
    // AvailabilityManager._markAllAvailable already fires the flow trigger.
  }

  async onBecameUnavailable(reason) {
    this.log(`Device became unavailable (${reason})`);
    if (super.onBecameUnavailable) await super.onBecameUnavailable(reason);
    // AvailabilityManager._markAllUnavailable already fires the flow trigger.
  }

}

module.exports = SonoffDongleDevice;
