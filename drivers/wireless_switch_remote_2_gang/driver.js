'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class WirelessSwitchRemote2GangDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();

    this.homey.flow.getActionCard('wireless_switch_remote_2_gang_simulate_press')
      .registerRunListener(async args => {
        const [ep, pressType] = args.action.split('-');
        args.device._applyButtonAction(Number(ep), pressType);
      });
  }

}

module.exports = WirelessSwitchRemote2GangDriver;
