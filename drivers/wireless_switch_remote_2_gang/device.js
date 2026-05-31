'use strict';

// Tuya TS0042 2-button wireless remote (_TZ3000_tzvbimpq).
// Driver seeded from JohanBendz/com.tuya.zigbee; button protocol confirmed via
// sniffer (capture "wireless remote switch 2 botoes.pcapng") and cross-checked
// against zigbee2mqtt (fz.tuya_on_off_action). Assets (icon/images) © Johan Bendz.
//
// Each button = an endpoint (1 = left, 2 = right). A press is an onOff
// (cluster 6) cluster-specific command 0xFD; the press type is byte frame[3]:
//   0 = single, 1 = double, 2 = long.
// Buttons are exposed by NUMBER (1..2) for parity with moes_remote_4_gang.

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const ACTION = { 0: 'single', 1: 'double', 2: 'long' };

class WirelessSwitchRemote2Gang extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {

    // Battery level (powerConfiguration, batteryPercentageRemaining: ZCL 0-200 -> %).
    // Sleepy device: don't read on start, just parse the spontaneous reports.
    if (this.hasCapability('measure_battery')) {
      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        report: 'batteryPercentageRemaining',
        reportParser: v => (typeof v === 'number' ? Math.round(v / 2) : null),
        getOpts: { getOnStart: false },
      });
    }

    this._buttonTrigger = this.homey.flow.getDeviceTriggerCard('wireless_switch_remote_2_gang_button')
      .registerRunListener((args, state) => args.action === state.action);

    // Wrap node.handleFrame (don't replace it): intercept the button commands on
    // cluster 6, but forward every other frame to the original handler so battery
    // reports (cluster 1) and normal ZCL processing keep working.
    const node = await this.homey.zigbee.getNode(this);
    const original = typeof node.handleFrame === 'function' ? node.handleFrame.bind(node) : null;
    node.handleFrame = (endpointId, clusterId, frame, meta) => {
      if (clusterId === 6) {
        this._parseButton(endpointId, frame);
        return false;
      }
      return original ? original(endpointId, clusterId, frame, meta) : false;
    };
  }

  _parseButton(ep, frame) {
    // This device's capture sends one frame per press (unique tsn), but sibling
    // TS004x firmwares double-fire with a shared tsn (Johan issue #793). Keep the
    // cheap dedup as defensive parity: skip an immediate repeat of the same tsn.
    const tsn = frame[1];
    if (tsn === this._lastTsn) return;
    this._lastTsn = tsn;

    if (ep < 1 || ep > 2) return;
    const action = `${ep}-${ACTION[frame[3]] ?? 'single'}`;

    this._buttonTrigger.trigger(this, {}, { action })
      .then(() => this.log('Button:', action))
      .catch(err => this.error('Button trigger failed:', err));
  }

  onDeleted() {
    this.log('2 Gang Wireless Remote removed');
  }

}

module.exports = WirelessSwitchRemote2Gang;
