'use strict';

const NovaDigitalTuyaDpSwitchBase = require('../../lib/NovaDigitalTuyaDpSwitchBase');

const DP = {
  GANG1:    1,
  GANG2:    2,
  GANG3:    3,
  GANG4:    4,
  POWER_ON: 14,
};

const DP_MAP = {
  main:       DP.GANG1,
  secondGang: DP.GANG2,
  thirdGang:  DP.GANG3,
  fourthGang: DP.GANG4,
};

const GANG_LABELS = {
  secondGang: 'Gang 2',
  thirdGang:  'Gang 3',
  fourthGang: 'Gang 4',
};

const POWER_ON_MODE = { 0: 'off', 1: 'on', 2: 'lastState' };
const POWER_ON_LABELS = { off: 'Always Off', on: 'Always On', lastState: 'Last State' };

class NovaDigitalSwitch4Gang extends NovaDigitalTuyaDpSwitchBase {

  _getDpMap()        { return DP_MAP; }
  _getGangLabels()   { return GANG_LABELS; }
  _getMainDpExtras() { return [DP.POWER_ON]; }

  async _handleDatapoint(dp, value) {
    if (dp === DP.POWER_ON) {
      if (!this._isMain) return;
      const mode = POWER_ON_MODE[value];
      if (!mode) { this.error(`Unknown power-on value: ${value}`); return; }
      this.log(`powerOnBehavior reported: ${mode}`);
      await this.setSettings({
        power_on_behavior:         mode,
        power_on_behavior_current: POWER_ON_LABELS[mode],
      }).catch(err => this.error('setSettings powerOn:', err));
      return;
    }
    await this._handleOnOff(dp, value);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!this._isMain) return;
    for (const key of changedKeys) {
      if (key === 'power_on_behavior') {
        // Accept 'memory' as legacy alias for 'lastState'
        const normalized = newSettings[key] === 'memory' ? 'lastState' : newSettings[key];
        const enumValue = Object.entries(POWER_ON_MODE).find(([, v]) => v === normalized)?.[0];
        if (enumValue === undefined) throw new Error(`Invalid power_on_behavior: ${newSettings[key]}`);
        await this.writeEnum(DP.POWER_ON, Number(enumValue))
          .catch(err => { this.error('Write powerOn:', err.message); throw err; });
      }
      // power_on_behavior_current is read-only label — ignore
    }
  }

}

module.exports = NovaDigitalSwitch4Gang;
