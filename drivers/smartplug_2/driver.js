'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SmartPlug2Driver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('diagnostic _TZ3210_fgwhjm9j driver initialized');
  }
}

module.exports = SmartPlug2Driver;
