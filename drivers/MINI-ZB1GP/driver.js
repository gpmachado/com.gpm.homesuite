'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffMINIZB1GPDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();

    this.homey.flow
      .getActionCard('mini_zb1gp_reset_consumption')
      .registerRunListener(async (args) => {
        await args.device._resetConsumption();
      });

    this.log('MINI-ZB1GP driver initialized');
  }

}

module.exports = SonoffMINIZB1GPDriver;
