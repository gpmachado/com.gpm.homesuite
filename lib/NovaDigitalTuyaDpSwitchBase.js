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
    // Main device also tracks the DP burst for rejoin detection:
    // on power restore, all gangs dump their state simultaneously (<600ms).
    // In normal use the user toggles one gang at a time — no burst.
    if (this._isMain) {
      this._reportingFn = data => {
        this._trackDpBurst();
        this._processDatapoint(data).catch(e => this.error('DP reporting error:', e));
      };
      this._responseFn = data => {
        this._trackDpBurst();
        this._processDatapoint(data).catch(e => this.error('DP response error:', e));
      };
    } else {
      this._reportingFn = data => this._processDatapoint(data).catch(e => this.error('DP reporting error:', e));
      this._responseFn  = data => this._processDatapoint(data).catch(e => this.error('DP response error:', e));
    }

    tuya.on('reporting', this._reportingFn);
    tuya.on('response',  this._responseFn);

    if (this._isMain) this.log('Tuya listeners attached');
  }

  /**
   * Track DP arrivals on the main device. All gang DPs route through this
   * listener even if _isMyDp() filters them out in _processDatapoint.
   * 3+ DPs within 600ms = rejoin state dump.
   */
  _trackDpBurst() {
    const now = Date.now();
    // Suppress the command echo: a flow toggling 3+ gangs lands 3+ responses in <600ms,
    // identical to a boot dump. A real boot dump is spontaneous — no preceding hub command.
    if (now - (this._lastCommandAt ?? 0) < 2000) return;
    this._burstWindow = (this._burstWindow ?? []).filter(t => now - t < 600);
    this._burstWindow.push(now);
    if (this._burstWindow.length >= 3) this._notifyRejoin();
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

  /**
   * Signal that this device rejoined after a power cut.
   * Call from subclass when a powerOnState DP arrives (only fires on power restore).
   * Guard: 30s cooldown deduplicates burst reports from the same rejoin event.
   */
  _notifyRejoin() {
    if (!this._isMain) return;  // only main device fires the flow trigger
    const now = Date.now();
    if ((now - (this._lastRejoinTs ?? 0)) < 30_000) return; // burst cooldown
    this._lastRejoinTs = now;
    this.onDeviceRejoin();
  }

  /**
   * Called by _notifyRejoin — fires the device_rejoined flow trigger.
   * Override in subclass if needed.
   */
  onDeviceRejoin() {
    this.log(`[${this._gangLabel}] Device rejoined`);
    const AvailabilityManager = require('./AvailabilityManager');
    const cardId = this.driver?.id ? `${this.driver.id}:device_rejoined` : null;
    AvailabilityManager.triggerRejoin(this, 0, cardId);
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
    // Stamp this hub command on all gang siblings so the main's _trackDpBurst can suppress
    // the response echo. A flow toggling N gangs at once produces the same all-ON DP dump as
    // a power-restore boot — the only difference is this preceding command, so value-based
    // detection is impossible.
    const _cmdNow = Date.now();
    this._lastCommandAt = _cmdNow;
    try {
      const { getNodeDevices } = require('./connectedDevices');
      for (const d of getNodeDevices(this)) d._lastCommandAt = _cmdNow;
    } catch { /* siblings best-effort; self is stamped */ }
    await this.writeBool(this._myDp, value)
      .catch(err => { this.error(`[${this._gangLabel}] writeBool failed:`, err.message); throw err; });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  // onUninit fires on re-init/restart; onDeleted only on user removal.
  // Both must clean up to avoid orphaned listeners/hooks.
  async onUninit() {
    await this._teardown();
  }

  onDeleted() {
    this._teardown();
    this.log(`[${this._gangLabel}] removed`);
  }

  /** Idempotent cleanup — safe to call from both onUninit and onDeleted. */
  async _teardown() {
    const tuya = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (tuya) {
      if (this._reportingFn) tuya.removeListener('reporting', this._reportingFn);
      if (this._responseFn)  tuya.removeListener('response',  this._responseFn);
    }
    await this._availability?.uninstall().catch(() => {});
  }

  onRenamed(name) {
    this.log(`Device renamed to: ${name}`);
    this._updateSiblingNames();
  }

}

module.exports = NovaDigitalTuyaDpSwitchBase;
