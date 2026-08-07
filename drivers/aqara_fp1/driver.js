'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class AqaraFP1Driver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');

    this.homey.flow
      .getActionCard('aqara_fp1_reset_presence')
      .registerRunListener(async (args) => {
        await args.device._resetPresence();
      });
  }

}

module.exports = AqaraFP1Driver;
