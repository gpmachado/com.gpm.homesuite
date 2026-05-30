'use strict';

// Moes / Tuya TS0044 4-button scene remote (_TZ3000_wkai4ga5).
// Driver seeded from JohanBendz/com.tuya.zigbee (MIT); button protocol confirmed
// via sniffer and cross-checked against zigbee2mqtt (fz.tuya_on_off_action).
// Assets (icon/images) © Johan Bendz, MIT.
//
// Each button = an endpoint (1..4). A press is an onOff (cluster 6)
// cluster-specific command 0xFD; the press type is byte frame[3]:
//   0 = single, 1 = double, 2 = long.
// Buttons are exposed by NUMBER (1..4), not physical position, because the
// physical layout varies between firmwares (see Johan issues #270 / #793).

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const ACTION = { 0: 'single', 1: 'double', 2: 'long' };

class MoesRemote4Gang extends ZigBeeDevice {

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

    this._buttonTrigger = this.homey.flow.getDeviceTriggerCard('moes_remote_4_gang_button')
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
    // TS0044 emits the same press twice; the pair shares the ZCL transaction
    // sequence number (frame[1]). Skip an immediate repeat → one trigger per
    // press (fixes the double-fire reported in Johan issue #793).
    const tsn = frame[1];
    if (tsn === this._lastTsn) return;
    this._lastTsn = tsn;

    if (ep < 1 || ep > 4) return;
    const action = `${ep}-${ACTION[frame[3]] ?? 'single'}`;

    this._buttonTrigger.trigger(this, {}, { action })
      .then(() => this.log('Button:', action))
      .catch(err => this.error('Button trigger failed:', err));
  }

  onDeleted() {
    this.log('Moes 4 Gang Wall Remote removed');
  }

}

module.exports = MoesRemote4Gang;
