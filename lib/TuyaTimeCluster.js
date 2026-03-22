'use strict';

const { Cluster } = require('zigbee-clusters');

class TuyaTimeCluster extends Cluster {

  static get ID() {
    return 10; // 0x000A Time
  }

  static get NAME() {
    return 'time';
  }

  static get ATTRIBUTES() {
    return {
      time: { id: 0, type: 'utcTime' },
      timeStatus: { id: 1, type: 'bitmap8' },
      timeZone: { id: 2, type: 'int32' },
      dstStart: { id: 3, type: 'uint32' },
      dstEnd: { id: 4, type: 'uint32' },
      dstShift: { id: 5, type: 'int32' },
      standardTime: { id: 6, type: 'uint32' },
      localTime: { id: 7, type: 'uint32' },
      lastSetTime: { id: 8, type: 'utcTime' },
      validUntilTime: { id: 9, type: 'utcTime' },
    };
  }

  static get COMMANDS() {
    return {};
  }
}

module.exports = TuyaTimeCluster;
