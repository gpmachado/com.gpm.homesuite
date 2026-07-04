'use strict';

const TuyaRelayMultiGangBase = require('../../lib/TuyaRelayMultiGangBase');

class Switch2ChDevice extends TuyaRelayMultiGangBase {

  get gangCount() {
    return 2;
  }

}

module.exports = Switch2ChDevice;
