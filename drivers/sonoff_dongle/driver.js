'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffDongleDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = SonoffDongleDriver;
