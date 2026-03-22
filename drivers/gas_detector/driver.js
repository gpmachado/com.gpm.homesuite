'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class GasDetectorDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = GasDetectorDriver;
