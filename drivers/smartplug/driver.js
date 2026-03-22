'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SmartPlugDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = SmartPlugDriver;
