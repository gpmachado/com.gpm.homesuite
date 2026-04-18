'use strict';

const { CLUSTER } = require('zigbee-clusters');
const SonoffBase = require('../../lib/SonoffBase');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
const { SONOFF_HEARTBEAT_TIMEOUT_MS } = require('../../lib/constants');

class SonoffBASICZBR3 extends SonoffBase {

  async onNodeInit({ zclNode }) {
    super.onNodeInit({ zclNode });

    if (this.hasCapability('onoff')) {
      this.registerCapability('onoff', CLUSTER.ON_OFF);
    }

    // Migrate existing paired devices: add is_availability if missing
    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    // Availability tracking
    this._availability = new AvailabilityManagerCluster0(this, { timeout: SONOFF_HEARTBEAT_TIMEOUT_MS });
    await this._availability.install();

    this.log('BASICZBR3 initialized');
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

  async onDeleted() {
    this.log('BASICZBR3 removed');
    await this._availability?.uninstall().catch(() => {});
  }

}

module.exports = SonoffBASICZBR3;
