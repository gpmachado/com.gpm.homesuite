'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class NovaDigitalSwitch3GangDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = NovaDigitalSwitch3GangDriver;
