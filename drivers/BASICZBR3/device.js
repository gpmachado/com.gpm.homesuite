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
      // BASICZBR3 firmware does not send ZCL Default Response to setOn/setOff.
      // Same fix as ZBMINIR2: wire manually with waitForResponse: false.
      const _onOffCluster = zclNode.endpoints[1].clusters.onOff;

      _onOffCluster.on('attr.onOff', value => {
        this.log(`handle report (cluster: onOff, capability: onoff), parsed payload: ${value}`);
        this.setCapabilityValue('onoff', value).catch(this.error);
      });

      this.registerCapabilityListener('onoff', async value => {
        this.log(`set onoff → ${value} (cluster: onOff, endpoint: 1)`);
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    // Availability tracking
    this._startedAt = Date.now();
    this._availability = new AvailabilityManagerCluster0(this, { timeout: SONOFF_HEARTBEAT_TIMEOUT_MS });
    await this._availability.install();

    // NOTE: BASICZBR3 firmware responds UNSUP_GENERAL_COMMAND to all ZCL general commands
    // (confirmed via Homey Interview). configureAttributeReporting is not supported.
    // Availability is tracked via handleFrame (state-change commands and AM watchdog).
    this.log('BASICZBR3 initialized');
  }

  async onBecameAvailable() {
    this.log('Device became available');
    if (super.onBecameAvailable) await super.onBecameAvailable();
    // 120s boot guard: skip the rejoin trigger if the app just restarted
    // (AvailabilityManager seeds last_seen_ts on install, so the first
    //  _markAllAvailable after startup fires too early to count as rejoin).
    const uptime = Date.now() - (this._startedAt ?? 0);
    if (uptime > 120_000) {
      AvailabilityManager.triggerRejoin(this, 0, 'BASICZBR3:device_rejoined');
    }
    // configureAttributeReporting omitted: BASICZBR3 does not support it (UNSUP_GENERAL_COMMAND).
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
