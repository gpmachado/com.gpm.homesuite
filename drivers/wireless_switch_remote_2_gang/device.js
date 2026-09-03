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
const { TimeServerBoundCluster } = require('../../lib/TimeCluster');

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

    try { zclNode.endpoints[1].bind('time', new TimeServerBoundCluster()); } catch {}

    // Wrap node.handleFrame (don't replace it): intercept the button commands on
    // cluster 6, but forward every other frame to the original handler so battery
    // reports (cluster 1) and normal ZCL processing keep working.
    // Guarded against re-installing on re-init: this.node can be reused by the
    // framework across an onNodeInit re-run, and wrapping handleFrame again on
    // the same node would stack interceptors indefinitely.
    const node = await this.homey.zigbee.getNode(this);
    if (node._wsr2gFrameHookInstalled) {
      this.log('handleFrame hook already installed (shared node)');
    } else {
      node._wsr2gFrameHookInstalled = true;
      const original = typeof node.handleFrame === 'function' ? node.handleFrame.bind(node) : null;
      node.handleFrame = (endpointId, clusterId, frame, meta) => {
        if (clusterId === 6) {
          this._parseButton(endpointId, frame);
          return false;
        }
        return original ? original(endpointId, clusterId, frame, meta) : false;
      };
    }
  }

  _parseButton(ep, frame) {
    // This device's capture sends one frame per press (unique tsn), but sibling
    // TS004x firmwares double-fire with a shared tsn (Johan issue #793). Keep the
    // cheap dedup as defensive parity: skip an immediate repeat of the same tsn.
    const tsn = frame[1];
    if (tsn === this._lastTsn) return;
    this._lastTsn = tsn;

    if (ep < 1 || ep > 2) return;
    this._applyButtonAction(ep, ACTION[frame[3]] ?? 'single');
  }

  /**
   * Fire the button trigger and update the Last button/action/click
   * capabilities. Shared by real presses (_parseButton) and the
   * "Simulate button press" flow action.
   * @param {number} ep - 1 or 2
   * @param {'single'|'double'|'long'} pressType
   */
  _applyButtonAction(ep, pressType) {
    const action = `${ep}-${pressType}`;

    this._buttonTrigger.trigger(this, {}, { action })
      .then(() => this.log('Button:', action))
      .catch(err => this.error('Button trigger failed:', err));

    const ACTION_LABEL = { single: '1 Click', double: '2 Clicks', long: 'Long Press' };
    const label = ACTION_LABEL[pressType] ?? pressType;
    this.setCapabilityValue('last_button', ep).catch(this.error);
    this.setCapabilityValue('last_action', label).catch(this.error);
    this.setCapabilityValue(`button${ep}_action`, label).catch(this.error);

    let tz = 'UTC';
    try {
      const result = this.homey.clock.getTimezone();
      if (typeof result === 'string' && result.length > 0) tz = result;
    } catch { /* use UTC fallback */ }
    const timestamp = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());
    this.setCapabilityValue('last_click', timestamp).catch(this.error);
  }

  onDeleted() {
    this.log('2 Gang Wireless Remote removed');
  }

}

module.exports = WirelessSwitchRemote2Gang;
