'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffMINIZB1GPDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('MINI-ZB1GP driver initialized');
  }

}

module.exports = SonoffMINIZB1GPDriver;
