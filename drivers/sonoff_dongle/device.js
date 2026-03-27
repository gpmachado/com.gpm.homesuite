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

    // Read basic attributes once to confirm communication on first contact.
    await zclNode.endpoints[1].clusters.basic
      .readAttributes(['manufacturerName', 'modelId', 'appVersion'])
      .then(attrs => this.log('[basic]', attrs))
      .catch(readAttrCatch(this, '[basic] readAttributes', { markOffline: true }));

    // Silence ZCL time cluster frames.
    try { zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster()); } catch {}

    // Passive availability watchdog: cluster 6 (onOff) is configured with
    // maxInterval 600s — the device sends reports every ≤10 min, which keeps
    // last_seen_ts fresh via handleFrame. Timeout = 25 min (2.5× max interval).
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: SONOFF_DONGLE_HEARTBEAT_MS,
    });
    await this._availability.install();
  }

  onEndDeviceAnnounce() {
    this.log('Rejoined — availability will be restored via handleFrame');
  }

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log('Sonoff Dongle removed');
  }

  async onBecameAvailable() {
    this.log('Device became available');
    if (super.onBecameAvailable) await super.onBecameAvailable();
    AvailabilityManager.trigger(this, true);
  }

  async onBecameUnavailable(reason) {
    this.log(`Device became unavailable (${reason})`);
    if (super.onBecameUnavailable) await super.onBecameUnavailable(reason);
    AvailabilityManager.trigger(this, false);
  }

}

module.exports = SonoffDongleDevice;
