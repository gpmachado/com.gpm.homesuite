'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_TIMEOUT_MS } = require('../../lib/constants');


const DP = {
  GANG1: 1,
  GANG2: 2,
  GANG3: 3,
  GANG4: 4,
  GANG5: 5,
  GANG6: 6,
};

const GANG_LABELS = {
  secondGang: 'Gang 2',
  thirdGang:  'Gang 3',
  fourthGang: 'Gang 4',
  fifthGang:  'Gang 5',
  sixthGang:  'Gang 6',
};

class NovaDigitalSwitch6Gang extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    this._myDp      = this._getMyDp(subDeviceId);
    this._isMain    = !subDeviceId;
    this._gangLabel = GANG_LABELS[subDeviceId] || 'Gang 1';
    this._fromDevice = false;   // guard: prevents DP-triggered setCapabilityValue
                                 // from re-entering _onCapabilityOnOff

    this.log(`[${this._gangLabel}] init -- firstInit:${this.isFirstInit()}`);
    if (this._isMain) {
      this.printNode();
    }

    if (this._isMain) {
      // Passive availability: handleFrame hook on every inbound frame.
      // Sibling cascade handled by AvailabilityManagerCluster0._getSiblings().
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: HEARTBEAT_TIMEOUT_MS,
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
    // 'response'  = device → coordinator after receiving a command  (echo / ACK)
    this._reportingFn = data => this._processDatapoint(data).catch(e => this.error('DP reporting error:', e));
    this._responseFn  = data => this._processDatapoint(data).catch(e => this.error('DP response error:',  e));

    tuya.on('reporting', this._reportingFn);
    tuya.on('response',  this._responseFn);

    if (this._isMain) this.log('Tuya listeners attached');
  }

  async _processDatapoint(data) {
    const dp = data?.dp;
    if (!this._isMyDp(dp)) return;               // ignore DPs that belong to other gangs

    const value = this._parseDataValue(data);

    if (dp >= DP.GANG1 && dp <= DP.GANG6) {
      await this._handleOnOff(dp, value);
    }
  }

  async _handleOnOff(dp, value) {
    if (this.getCapabilityValue('onoff') === value) return;

    // Set guard BEFORE setCapabilityValue so that if the Homey SDK fires
    // registerCapabilityListener as part of the update, _onCapabilityOnOff
    // skips the writeBool echo (the device already has the correct state).
    this._fromDevice = true;
    await this.setCapabilityValue('onoff', value)
      .catch(err => this.error('setCapabilityValue onoff:', err));
    this._fromDevice = false;

    this.log(`[${this._gangLabel}] DP${dp}: ${value ? 'ON' : 'OFF'}`);
  }

  async _onCapabilityOnOff(value) {
    // Guard: if this call was triggered by setCapabilityValue inside _handleOnOff
    // (feedback loop), bail out — the device already sent us the correct state.
    if (this._fromDevice) return;

    if (this.getCapabilityValue('onoff') === value) return;
    this.log(`[${this._gangLabel}] command: ${value ? 'ON' : 'OFF'}`);
    await this.writeBool(this._myDp, value)
      .catch(err => { this.error(`[${this._gangLabel}] writeBool failed:`, err.message); throw err; });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _getMyDp(subDeviceId) {
    const map = {
      secondGang: DP.GANG2, thirdGang: DP.GANG3, fourthGang: DP.GANG4,
      fifthGang: DP.GANG5, sixthGang: DP.GANG6,
    };
    return map[subDeviceId] || DP.GANG1;
  }

  _isMyDp(dp) {
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
    if (!this._isMain) return;

    try {
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

module.exports = NovaDigitalSwitch6Gang;
