'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SmartPlug3Driver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('diagnostic _TZ3000_cehuw1lw driver initialized');
  }
}

module.exports = SmartPlug3Driver;
