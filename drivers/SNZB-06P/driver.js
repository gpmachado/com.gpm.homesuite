'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffSNZB06PDriver extends ZigBeeDriver {

  onInit() {
    this.homey.flow.getConditionCard('is_bright')
      .registerRunListener(({ device }) => (
        device.getCapabilityValue('sonoff_illuminance') === 'bright'
      ));

    this.log('SNZB-06P driver initialized');
  }

}

module.exports = SonoffSNZB06PDriver;
