'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
const { readAttrCatch } = require('../../lib/errorUtils');
const { HEARTBEAT_TIMEOUT_MS } = require('../../lib/constants');
const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');


class ZigbeeRepeaterDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.log('Repeater init:', this.getName());

    // Read basic attributes once to confirm communication on first contact.
    await zclNode.endpoints[1].clusters.basic
      .readAttributes(['manufacturerName', 'modelId', 'appVersion'])
      .then(attrs => this.log('[basic]', attrs))
      .catch(readAttrCatch(this, '[basic] readAttributes', { markOffline: true }));

    // Silence ZCL time cluster frames (repeater probes coordinator's time cluster)
    try { zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster()); } catch {}

    // Passive availability watchdog: handleFrame hook on raw ZigBee node.
    // Fires on every inbound frame (basic attr reports, poll responses, etc.).
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: HEARTBEAT_TIMEOUT_MS,
    });
    await this._availability.install();
  }

  // ---------------------------------------------------------------------------
  // Availability helpers
  // ---------------------------------------------------------------------------

  onEndDeviceAnnounce() {
    this.log('Rejoined — availability will be restored via handleFrame');
  }

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log('Repeater removed');
  }

  // ---------------------------------------------------------------------------
  // Availability Flow Engine
  // ---------------------------------------------------------------------------

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

module.exports = ZigbeeRepeaterDevice;
