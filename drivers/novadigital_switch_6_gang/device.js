'use strict';

const NovaDigitalTuyaDpSwitchBase = require('../../lib/NovaDigitalTuyaDpSwitchBase');

const DP_MAP = {
  main:       1,
  secondGang: 2,
  thirdGang:  3,
  fourthGang: 4,
  fifthGang:  5,
  sixthGang:  6,
};

const GANG_LABELS = {
  secondGang: 'Gang 2',
  thirdGang:  'Gang 3',
  fourthGang: 'Gang 4',
  fifthGang:  'Gang 5',
  sixthGang:  'Gang 6',
};

class NovaDigitalSwitch6Gang extends NovaDigitalTuyaDpSwitchBase {
  _getDpMap()     { return DP_MAP; }
  _getGangLabels(){ return GANG_LABELS; }
}

module.exports = NovaDigitalSwitch6Gang;
