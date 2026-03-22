'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class LCDTempHumidSensorDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = LCDTempHumidSensorDriver;