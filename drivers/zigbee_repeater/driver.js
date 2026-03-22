'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class ZigbeeRepeaterDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = ZigbeeRepeaterDriver;
