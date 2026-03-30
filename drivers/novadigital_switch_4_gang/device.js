'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { TUYA_HEARTBEAT_TIMEOUT_MS } = require('../../lib/constants');


const DP = {
  GANG1: 1,
  GANG2: 2,
  GANG3: 3,
  GANG4: 4,
  POWER_ON: 14,
};

const POWER_ON_MODE = { 0: 'off', 1: 'on', 2: 'memory' };
const POWER_ON_LABELS = {
  off: 'Always Off',
  on: 'Always On',
  memory: 'Remember Last State',
};

const GANG_LABELS = {
  secondGang: 'Gang 2',
  thirdGang: 'Gang 3',
  fourthGang: 'Gang 4',
};

class NovaDigitalSwitch4Gang extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    this._myDp = this._getMyDp(subDeviceId);
    this._isMain = !subDeviceId;
    this._gangLabel = GANG_LABELS[subDeviceId] || 'Gang 1';
    this._fromDevice = false;

    this.log(`[${this._gangLabel}] init -- firstInit:${this.isFirstInit()}`);
    if (this._isMain) {
      this.printNode();
    }

    if (this._isMain) {
      // Passive availability: handleFrame hook captures every inbound frame.
      // Sibling cascade handled by AvailabilityManagerCluster0._getSiblings().
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: TUYA_HEARTBEAT_TIMEOUT_MS,
      });
      await this._availability.install();
      await this._updateSiblingNames();
    }

    // EVERY gang attaches its own listener directly on the shared Tuya cluster.
    // This avoids a single-point-of-failure in the Gang-1 dispatch path and ensures
    // physical-key DP reports are never silently dropped due to sibling-lookup races.
    this._setupTuyaListeners(zclNode);

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    this.log(`[${this._gangLabel}] ready`);
  }

  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints?.[1]?.clusters?.tuya;
    if (!tuya) { this.error(`[${this._gangLabel}] Tuya cluster not found on EP1`); return; }

    // Store named references so they can be removed in onDeleted (prevents listener
    // accumulation across re-interviews / re-pairings on the same zclNode instance).
    // 'reporting' = unsolicited device → coordinator (physical key press, state change)
    // 'response'  = device → coordinator after receiving a command (echo / ACK)
    this._reportingFn = data => this._processDatapoint(data).catch(e => this.error('DP reporting error:', e));
    this._responseFn  = data => this._processDatapoint(data).catch(e => this.error('DP response error:',  e));

    tuya.on('reporting', this._reportingFn);
    tuya.on('response',  this._responseFn);

    if (this._isMain) this.log('Tuya listeners attached');
  }

  async _processDatapoint(data) {
    const dp = data.dp;
    const value = this._parseDataValue(data);
    if (!this._isMyDp(dp)) return;

    switch (dp) {
      case DP.GANG1:
      case DP.GANG2:
      case DP.GANG3:
      case DP.GANG4:
        await this._handleOnOff(dp, value);
        break;
      case DP.POWER_ON:
        await this._handlePowerOn(value);
        break;
    }
  }

  async _handleOnOff(dp, value) {
    if (this.getCapabilityValue('onoff') === value) return;

    this._fromDevice = true;
    await this.setCapabilityValue('onoff', value)
      .catch(err => this.error('setCapabilityValue onoff:', err));
    this._fromDevice = false;

    this.log(`[${this._gangLabel}] DP${dp}: ${value ? 'ON' : 'OFF'}`);
  }

  async _handlePowerOn(value) {
    if (!this._isMain) return;
    const mode = POWER_ON_MODE[value];
    if (!mode) { this.error(`Unknown power-on value: ${value}`); return; }
    this.log(`powerOnBehavior reported: ${mode}`);
    await this.setSettings({
      power_on_behavior: mode,
      power_on_behavior_current: POWER_ON_LABELS[mode],
    }).catch(err => this.error('setSettings powerOn:', err));
  }

  async _onCapabilityOnOff(value) {
    if (this._fromDevice) return;
    if (this.getCapabilityValue('onoff') === value) return;
    this.log(`[${this._gangLabel}] command: ${value ? 'ON' : 'OFF'}`);
    await this.writeBool(this._myDp, value)
      .catch(err => { this.error(`[${this._gangLabel}] writeBool failed:`, err.message); throw err; });
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!this._isMain) return;
    for (const key of changedKeys) {
      switch (key) {
        case 'power_on_behavior': {
          const enumValue = Object.entries(POWER_ON_MODE)
            .find(([, v]) => v === newSettings[key])?.[0];
          if (enumValue === undefined) throw new Error(`Invalid power_on_behavior: ${newSettings[key]}`);
          await this.writeEnum(DP.POWER_ON, Number(enumValue))
            .catch(err => { this.error('Write powerOn:', err.message); throw err; });
          break;
        }
        case 'power_on_behavior_current':
          // read-only label — ignore
          break;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _getMyDp(subDeviceId) {
    const map = { secondGang: DP.GANG2, thirdGang: DP.GANG3, fourthGang: DP.GANG4 };
    return map[subDeviceId] || DP.GANG1;
  }

  _isMyDp(dp) {
    if (this._isMain) return dp === DP.GANG1 || dp === DP.POWER_ON;
    return dp === this._myDp;
  }

  onDeleted() {
    const tuya = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (tuya) {
      if (this._reportingFn) tuya.removeListener('reporting', this._reportingFn);
      if (this._responseFn)  tuya.removeListener('response',  this._responseFn);
    }
    this._availability?.uninstall().catch(() => {});
    this.log(`[${this._gangLabel}] removed`);
  }

  // ---------------------------------------------------------------------------
  // Sibling Name Syncing
  // ---------------------------------------------------------------------------

  onRenamed(name) {
    this.log(`Device renamed to: ${name}`);
    this._updateSiblingNames();
  }

  async _updateSiblingNames() {
    if (!this._isMain) return; // only main device manages sibling labels

    try {
      // Use zclNode identity as fallback — more reliable for Tuya DP sub-devices
      // where getData().ieeeAddress may differ per gang.
      const myIeee = this.getData().ieeeAddress;
      const siblings = this.driver.getDevices().filter(d => {
        try {
          return myIeee
            ? d.getData().ieeeAddress === myIeee
            : d.zclNode === this.zclNode;
        } catch { return false; }
      });

      if (siblings.length > 0) await this._writeSiblingNames(siblings);
    } catch (err) {
      this.error('Error updating sibling names:', err.message);
    }
  }

}

module.exports = NovaDigitalSwitch4Gang;
