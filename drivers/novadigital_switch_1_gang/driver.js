'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class NovaDigitalSwitch1GangDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = NovaDigitalSwitch1GangDriver;
