'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class NovaDigitalSwitch4GangZCLDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');

    this.homey.flow.getActionCard('novadigital_switch_4_gang_zcl_set_backlight')
      .registerRunListener(async args => args.device._onSettingBacklight(args.state === 'on'));

    this.homey.flow.getConditionCard('novadigital_switch_4_gang_zcl_backlight_is_on')
      .registerRunListener(async args => args.device.isBacklightOn());
  }

}

module.exports = NovaDigitalSwitch4GangZCLDriver;
