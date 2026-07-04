'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

const ATTRIBUTES = {
  presenceKeepTime: { id: 0xE001, type: ZCLDataTypes.uint16 },
  motionSensitivity: { id: 0xE004, type: ZCLDataTypes.uint8 },
  staticSensitivity: { id: 0xE005, type: ZCLDataTypes.uint8 },
  ledIndicator: { id: 0xE009, type: ZCLDataTypes.uint8 },
  targetDistance: { id: 0xE00A, type: ZCLDataTypes.uint16 },
  motionDetectionDistance: { id: 0xE00B, type: ZCLDataTypes.uint16 },
};

const COMMANDS = {};

class ManuSpecificTuya3Cluster extends Cluster {

  static get ID() {
    return 57346; // 0xE002
  }

  static get NAME() {
    return 'manuSpecificTuya3';
  }

  static get ATTRIBUTES() {
    return ATTRIBUTES;
  }

  static get COMMANDS() {
    return COMMANDS;
  }

}

module.exports = ManuSpecificTuya3Cluster;
