'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class Fan3GangMoesDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = Fan3GangMoesDriver;
