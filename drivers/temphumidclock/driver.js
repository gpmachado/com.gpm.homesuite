'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class LCDTHClockDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = LCDTHClockDriver;