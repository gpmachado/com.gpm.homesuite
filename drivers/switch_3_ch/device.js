'use strict';

const TuyaRelayMultiGangBase = require('../../lib/TuyaRelayMultiGangBase');

class Switch3ChDevice extends TuyaRelayMultiGangBase {

  get gangCount() {
    return 3;
  }

}

module.exports = Switch3ChDevice;
