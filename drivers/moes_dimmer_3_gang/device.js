'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { APP_VERSION } = require('../../lib/constants');

const DRIVER_NAME = 'MOES 3-Gang Fan Controller';

// ─── Tuya Datapoints ─────────────────────────────────────────────────────────
// Confirmed by ZigBee sniffer (TS0601 / _TZE204_1v1dxkck)
// Wire speed range: 10–1000  =  1%–100%  (value / 10 = percent)
const DP = {
  // Gang 1
  SWITCH_1: 1,    // bool    on/off
  DIM_1:    2,    // value   current speed  10–1000 (1%–100%)
  MIN_1:    3,    // value   hw min speed   10–460  (1%–46%)
  MAX_1:    5,    // value   hw max speed  560–1000 (56%–100%)

  // Gang 2
  SWITCH_2: 7,    // bool
  DIM_2:    8,    // value
  MIN_2:    9,    // value
  MAX_2:    11,   // value

  // Gang 3
  SWITCH_3: 15,   // bool
  DIM_3:    16,   // value
  MIN_3:    17,   // value
  MAX_3:    19,   // value

  // Global — reported & writable on Gang 1 (main) only
  POWER_ON:  14,  // enum   0=off  1=on  2=memory
  BACKLIGHT: 21,  // enum   0=off  1=normal  2=inverted
};

// DP set per sub-device
const GANG_DP = {
  '':          { sw: DP.SWITCH_1, dim: DP.DIM_1, min: DP.MIN_1, max: DP.MAX_1 },
  secondGang:  { sw: DP.SWITCH_2, dim: DP.DIM_2, min: DP.MIN_2, max: DP.MAX_2 },
  thirdGang:   { sw: DP.SWITCH_3, dim: DP.DIM_3, min: DP.MIN_3, max: DP.MAX_3 },
};

const POWER_ON_MODE  = { 0: 'off', 1: 'on', 2: 'memory' };
const BACKLIGHT_MODE = { 0: 'off', 1: 'normal', 2: 'inverted' };

const GANG_ORDER = Object.freeze({ '': 0, secondGang: 1, thirdGang: 2 });
const GANG_SORT  = (a, b) =>
  (GANG_ORDER[a.getData().subDeviceId ?? ''] ?? 99) -
  (GANG_ORDER[b.getData().subDeviceId ?? ''] ?? 99);

// Speed conversion helpers
const WIRE_MAX = 1000;
const WIRE_MIN = 10;

/** Homey dim 0–1 → wire 10–1000, clamped to [minPct, maxPct] */
function dimToWire(dim, minPct, maxPct) {
  const wire = Math.round(dim * WIRE_MAX);
  return Math.max(minPct * 10, Math.min(maxPct * 10, Math.max(WIRE_MIN, wire)));
}

/** Wire 10–1000 → Homey dim 0–1 */
function wireToDim(wire) {
  return Math.max(0, Math.min(1, wire / WIRE_MAX));
}

// ─────────────────────────────────────────────────────────────────────────────

class MoesDimmer3Gang extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    this._gangName = { '': 'Gang 1', secondGang: 'Gang 2', thirdGang: 'Gang 3' }[subDeviceId] || 'Gang 1';
    this._gangDp   = GANG_DP[subDeviceId] || GANG_DP[''];
    this._isMain   = !subDeviceId;

    this.log(`${DRIVER_NAME} v${APP_VERSION} — ${this._gangName}`);
    if (this._isMain) this.printNode();

    this._dimDebounceTimer = null;
    this._pendingDimWire   = null;

    // Tuya cluster listeners are shared — attach only once, on the main device
    if (this._isMain) {
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: require('../../lib/constants').HEARTBEAT_TIMEOUT_MS,
      });
      await this._availability.install();

      this._setupTuyaListeners(zclNode);
    }

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));
    this.registerCapabilityListener('dim',   v => this._onCapabilityDim(v));

    this.log(`${this._gangName} ready`);
    this._updateSiblingNames({ sortFn: GANG_SORT });
  }

  // ─── Tuya cluster listeners ────────────────────────────────────────────────

  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints[1]?.clusters?.tuya;
    if (!tuya) { this.error('Tuya cluster not found on EP1'); return; }

    const dispatch = async (data) => {
      const target = this._getNodeDevices().find(d => d._isMyDp(data.dp));
      if (target) target._processDatapoint(data).catch(e => this.error('DP dispatch error:', e));
    };

    tuya.on('reporting', dispatch);
    tuya.on('response',  dispatch);
    this.log('Tuya listeners attached');
  }

  // ─── Datapoint → capability / setting ────────────────────────────────────

  async _processDatapoint(data) {
    const value = this._parseDataValue(data);
    if (value === null || value === undefined) return;

    const { sw, dim, min, max } = this._gangDp;

    switch (data.dp) {

      // ── on/off ──────────────────────────────────────────────────────────
      case sw:
        if (this.getCapabilityValue('onoff') !== value)
          await this.setCapabilityValue('onoff', value)
            .catch(e => this.error('onoff update:', e));
        break;

      // ── current speed ────────────────────────────────────────────────────
      case dim: {
        const dimVal = wireToDim(value);
        if (Math.abs((this.getCapabilityValue('dim') ?? 0) - dimVal) >= 0.005)
          await this.setCapabilityValue('dim', dimVal)
            .catch(e => this.error('dim update:', e));
        this.log(`${this._gangName} speed: ${Math.round(dimVal * 100)}%`);
        break;
      }

      // ── hardware min speed (sync setting from device) ─────────────────────
      case min: {
        const pct = Math.round(value / 10);
        this.log(`${this._gangName} hw-min: ${pct}%`);
        if (this.getSetting('minimumBrightness') !== pct)
          await this.setSettings({ minimumBrightness: pct })
            .catch(e => this.error('minBrightness sync:', e));
        break;
      }

      // ── hardware max speed (sync setting from device) ─────────────────────
      case max: {
        const pct = Math.round(value / 10);
        this.log(`${this._gangName} hw-max: ${pct}%`);
        if (this.getSetting('maximumBrightness') !== pct)
          await this.setSettings({ maximumBrightness: pct })
            .catch(e => this.error('maxBrightness sync:', e));
        break;
      }

      // ── global (main device only) ─────────────────────────────────────────
      case DP.POWER_ON:
        if (this._isMain) await this._syncSetting('powerOnState', POWER_ON_MODE[value]);
        break;

      case DP.BACKLIGHT:
        if (this._isMain) await this._syncSetting('backlightMode', BACKLIGHT_MODE[value]);
        break;
    }
  }

  // ─── Capability → device ──────────────────────────────────────────────────

  async _onCapabilityOnOff(value) {
    if (this.getCapabilityValue('onoff') === value) return;
    this.log(`${this._gangName} command: ${value ? 'ON' : 'OFF'}`);

    try {
      // Motor protection: pre-send current speed before powering on
      if (value && this.getSetting('enableMotorProtection')) {
        const currentWire = Math.max(WIRE_MIN, Math.round((this.getCapabilityValue('dim') ?? 0) * WIRE_MAX));
        await this.writeValue(this._gangDp.dim, currentWire);
        await this._sleep(this.getSetting('motorStartupDelay') ?? 1000);
      }
      await this.writeBool(this._gangDp.sw, value);
    } catch (err) {
      this.error(`${this._gangName} onoff failed:`, err.message);
      throw err;
    }
  }

  async _onCapabilityDim(value) {
    // dim = 0 → turn off (don't send a speed command)
    if (value === 0) {
      this.log(`${this._gangName} dim=0 → OFF`);
      try {
        await this.writeBool(this._gangDp.sw, false);
        if (this.getCapabilityValue('onoff') !== false)
          await this.setCapabilityValue('onoff', false).catch(e => this.error('onoff update:', e));
      } catch (err) {
        this.error(`${this._gangName} dim=0 off failed:`, err.message);
      }
      return;
    }

    const minPct = this.getSetting('minimumBrightness') ?? 1;
    const maxPct = this.getSetting('maximumBrightness') ?? 100;
    const wire   = dimToWire(value, minPct, maxPct);

    this._pendingDimWire = wire;

    if (this.getSetting('enableDebouncing')) {
      clearTimeout(this._dimDebounceTimer);
      const delay = this.getSetting('debounceDelay') ?? 800;
      this._dimDebounceTimer = this.homey.setTimeout(async () => {
        await this._applyDim(this._pendingDimWire);
        this._dimDebounceTimer = null;
      }, delay);
    } else {
      await this._applyDim(wire);
    }
  }

  async _applyDim(wire) {
    this.log(`${this._gangName} speed: ${wire / 10}%`);
    const wasOff = !this.getCapabilityValue('onoff');
    try {
      await this.writeValue(this._gangDp.dim, wire);
      // dim > 0 while off → auto turn on (respects motor protection delay)
      if (wasOff) {
        if (this.getSetting('enableMotorProtection')) {
          await this._sleep(this.getSetting('motorStartupDelay') ?? 1000);
        }
        await this.writeBool(this._gangDp.sw, true);
        await this.setCapabilityValue('onoff', true).catch(e => this.error('onoff update:', e));
        this.log(`${this._gangName} auto-ON after speed set`);
      }
    } catch (err) {
      this.error(`${this._gangName} dim failed:`, err.message);
      throw err;
    }
  }

  // ─── Settings → device ────────────────────────────────────────────────────

  async onSettings({ changedKeys, newSettings }) {
    for (const key of changedKeys) {
      switch (key) {

        case 'minimumBrightness':
          await this.writeValue(this._gangDp.min, newSettings.minimumBrightness * 10)
            .catch(err => { this.error('Min speed write:', err.message); throw err; });
          this.log(`${this._gangName} hw-min → ${newSettings.minimumBrightness}%`);
          break;

        case 'maximumBrightness':
          await this.writeValue(this._gangDp.max, newSettings.maximumBrightness * 10)
            .catch(err => { this.error('Max speed write:', err.message); throw err; });
          this.log(`${this._gangName} hw-max → ${newSettings.maximumBrightness}%`);
          break;

        case 'powerOnState':
          if (!this._isMain) break;
          await this._writeEnumSetting(DP.POWER_ON, POWER_ON_MODE, newSettings.powerOnState);
          break;

        case 'backlightMode':
          if (!this._isMain) break;
          await this._writeEnumSetting(DP.BACKLIGHT, BACKLIGHT_MODE, newSettings.backlightMode);
          break;

        // Local-only settings — no device write needed
        case 'enableDebouncing':
        case 'debounceDelay':
        case 'enableMotorProtection':
        case 'motorStartupDelay':
          this.log(`Local setting: ${key} = ${newSettings[key]}`);
          break;
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async _writeEnumSetting(dp, modeMap, newMode) {
    const entry = Object.entries(modeMap).find(([, v]) => v === newMode);
    if (!entry) throw new Error(`Invalid mode: ${newMode}`);
    await this.writeEnum(dp, Number(entry[0]));
    this.log(`DP${dp} → ${newMode}`);
  }

  async _syncSetting(key, value) {
    if (value === undefined || this.getSetting(key) === value) return;
    await this.setSettings({ [key]: value })
      .catch(e => this.error(`Setting sync ${key}:`, e));
    this.log(`Setting synced: ${key} = ${value}`);
  }

  /** Returns true if this gang instance owns the given DP */
  _isMyDp(dp) {
    const { sw, dim, min, max } = this._gangDp;
    if (dp === sw || dp === dim || dp === min || dp === max) return true;
    if (this._isMain && (dp === DP.POWER_ON || dp === DP.BACKLIGHT)) return true;
    return false;
  }


  _sleep(ms) {
    return new Promise(r => this.homey.setTimeout(r, ms));
  }

  onRenamed(name) {
    this.log(`Device renamed to: ${name}`);
    this._updateSiblingNames({ sortFn: GANG_SORT });
  }

  onDeleted() {
    clearTimeout(this._dimDebounceTimer);
    this._availability?.uninstall().catch(() => {});
    this.log(`${this._gangName} removed`);
  }
}

module.exports = MoesDimmer3Gang;
