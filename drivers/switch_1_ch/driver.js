'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class Switch1chDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');
  }

}

module.exports = Switch1chDriver;
