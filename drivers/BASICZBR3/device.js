'use strict';

const { CLUSTER } = require('zigbee-clusters');
const SonoffBase = require('../../lib/SonoffBase');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { SONOFF_HEARTBEAT_TIMEOUT_MS } = require('../../lib/constants');

class SonoffBASICZBR3 extends SonoffBase {

  async onNodeInit({ zclNode }) {
    super.onNodeInit({ zclNode });

    if (this.hasCapability('onoff')) {
      this.registerCapability('onoff', CLUSTER.ON_OFF);
    }

    // Availability tracking
    this._availability = new AvailabilityManagerCluster0(this, { timeout: SONOFF_HEARTBEAT_TIMEOUT_MS });
    await this._availability.install();

    this.log('BASICZBR3 initialized');
  }

  async onDeleted() {
    this.log('BASICZBR3 removed');
    await this._availability?.uninstall().catch(() => {});
  }

}

module.exports = SonoffBASICZBR3;
