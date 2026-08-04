'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffSNZB06PDriver extends ZigBeeDriver {

  onInit() {
    this.log('SNZB-06P driver initialized');
  }

}

module.exports = SonoffSNZB06PDriver;