'use strict';

const TuyaSpecificClusterDevice = require('./TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('./AvailabilityManager');
const { TUYA_HEARTBEAT_TIMEOUT_MS } = require('./constants');

/**
 * Base class for NovaDigital Tuya DP on/off switch drivers (4-gang, 6-gang).
 *
 * Handles the common lifecycle shared by all simple Tuya DP switches:
 *   - _isMain / _gangLabel / _myDp resolution
 *   - AvailabilityManager install (main device only)
 *   - Per-gang Tuya cluster listeners (reporting + response)
 *   - _handleOnOff with _fromDevice echo guard
 *   - _onCapabilityOnOff via writeBool
 *   - onDeleted listener cleanup
 *   - onRenamed → _updateSiblingNames
 *
 * Subclasses must implement:
 *   - _getDpMap()    → { [subDeviceId]: dpNumber, main: dpNumber }
 *   - _getGangLabels() → { [subDeviceId]: 'Gang N' }
 *
 * Subclasses may override:
 *   - _getMainDpExtras() → number[]  extra DPs routed to main (default [])
 *   - _handleDatapoint(dp, value)    to handle DPs beyond on/off
 */
class NovaDigitalTuyaDpSwitchBase extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    const dpMap     = this._getDpMap();
    const labels    = this._getGangLabels();

    this._myDp      = dpMap[subDeviceId] ?? dpMap.main;
    this._isMain    = !subDeviceId;
    this._gangLabel = labels[subDeviceId] || 'Gang 1';
    this._fromDevice = false;

    this.log(`[${this._gangLabel}] init — firstInit:${this.isFirstInit()}`);

    if (this._isMain) {
      this.printNode();
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: TUYA_HEARTBEAT_TIMEOUT_MS,
      });
      await this._availability.install();
      await this._updateSiblingNames({ mainOnly: true });
    }

    this._setupTuyaListeners(zclNode);
    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    this.log(`[${this._gangLabel}] ready`);
  }

  // ── Abstract ────────────────────────────────────────────────────────────────

  /** @returns {{ [subDeviceId]: number, main: number }} */
  _getDpMap() { throw new Error('_getDpMap() not implemented'); }

  /** @returns {{ [subDeviceId]: string }} */
  _getGangLabels() { throw new Error('_getGangLabels() not implemented'); }

  /** Extra DPs owned by the main device beyond its own switch DP. */
  _getMainDpExtras() { return []; }

  // ── Tuya listeners ──────────────────────────────────────────────────────────

  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints?.[1]?.clusters?.tuya;
    if (!tuya) {
      this.error(`[${this._gangLabel}] Tuya cluster not found on EP1`);
      return;
    }

    // Named references so onDeleted can remove them cleanly.
    this._reportingFn = data => this._processDatapoint(data).catch(e => this.error('DP reporting error:', e));
    this._responseFn  = data => this._processDatapoint(data).catch(e => this.error('DP response error:', e));

    tuya.on('reporting', this._reportingFn);
    tuya.on('response',  this._responseFn);

    if (this._isMain) this.log('Tuya listeners attached');
  }

  async _processDatapoint(data) {
    const dp = data?.dp;
    if (!this._isMyDp(dp)) return;
    const value = this._parseDataValue(data);
    await this._handleDatapoint(dp, value);
  }

  /** Override in subclass to handle additional DPs (e.g. POWER_ON). */
  async _handleDatapoint(dp, value) {
    await this._handleOnOff(dp, value);
  }

  async _handleOnOff(dp, value) {
    this._fromDevice = true;
    await this.setCapabilityValue('onoff', value)
      .catch(err => this.error('setCapabilityValue onoff:', err));
    this._fromDevice = false;
    this.log(`[${this._gangLabel}] DP${dp}: ${value ? 'ON' : 'OFF'}`);
  }

  _isMyDp(dp) {
    if (dp === this._myDp) return true;
    if (this._isMain) return this._getMainDpExtras().includes(dp);
    return false;
  }

  // ── Capability → device ─────────────────────────────────────────────────────

  async _onCapabilityOnOff(value) {
    if (this._fromDevice) return;
    if (this.getCapabilityValue('onoff') === value) return;
    this.log(`[${this._gangLabel}] command: ${value ? 'ON' : 'OFF'}`);
    await this.writeBool(this._myDp, value)
      .catch(err => { this.error(`[${this._gangLabel}] writeBool failed:`, err.message); throw err; });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  onDeleted() {
    const tuya = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (tuya) {
      if (this._reportingFn) tuya.removeListener('reporting', this._reportingFn);
      if (this._responseFn)  tuya.removeListener('response',  this._responseFn);
    }
    this._availability?.uninstall().catch(() => {});
    this.log(`[${this._gangLabel}] removed`);
  }

  onRenamed(name) {
    this.log(`Device renamed to: ${name}`);
    this._updateSiblingNames();
  }

}

module.exports = NovaDigitalTuyaDpSwitchBase;
