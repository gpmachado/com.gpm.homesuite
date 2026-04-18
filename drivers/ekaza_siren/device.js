'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_TIMEOUT_MS, APP_VERSION } = require('../../lib/constants');
const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');

const DRIVER_NAME = 'Ekaza Smart Siren';

// ─── Tuya Datapoints ─────────────────────────────────────────────────────────
// Confirmed by ZigBee sniffer (TS0601 / _TZE204_q76rtoa9)
const DP = {
  VOLUME:   5,   // enum    0=low  1=medium  2=high  (sniffer originally noted inverse; corrected by user testing)
  DURATION: 7,   // value   alarm duration in seconds (0–1800)
  ALARM:    13,  // bool    alarm active (true=on, false=off)
  BATTERY:  15,  // value   battery level 0–100 %
  MELODY:   21,  // enum    sound type 0–17 (18 melodies)
};

// ─── Melody name lookup (mirrors alarmtune dropdown labels in driver.compose.json) ──
const MELODY_NAMES = [
  'Doorbell Chime',           // 0
  'Für Elise',                // 1
  'Westminster Chimes',       // 2
  'Fast Double Doorbell',     // 3
  'William Tell Overture',    // 4
  'Turkish March',            // 5
  'Safe / Security Alarm',    // 6
  'Chemical Spill Alert',     // 7
  'Piercing Alarm Clock',     // 8
  'Smoke Alarm',              // 9
  'Dog Barking',              // 10
  'Police Siren',             // 11
  'Doorbell Chime (reverb)',  // 12
  'Mechanical Telephone',     // 13
  'Fire / Ambulance',         // 14
  '3/1 Elevator',             // 15
  'Buzzing Alarm Clock',      // 16
  'School Bell',              // 17
];

// ─────────────────────────────────────────────────────────────────────────────

class EkazaSiren extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this.log(`${DRIVER_NAME} v${APP_VERSION}`);
    try { zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster()); } catch {}
    this.printNode();

    this._alarmAutoResetTimer = null;

    // Migrate existing paired devices: add is_availability if missing
    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    // Availability management (non-fatal: getNode() may fail on first pairing)
    try {
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: HEARTBEAT_TIMEOUT_MS,
      });
      await this._availability.install();
    } catch (err) {
      this.error('[Siren] AvailabilityManager install failed (non-fatal):', err.message);
      this._availability = null;
    }

    this._setupTuyaListeners(zclNode);

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    // Populate melody name label from last-saved tune (before first device report arrives)
    const savedTune = Number(this.getSetting('alarmtune') ?? '5');
    this._syncSetting('melody_name', MELODY_NAMES[savedTune] ?? `Melody ${savedTune}`);

    this.log('Ekaza Siren ready');
  }

  // ─── Tuya cluster listeners ────────────────────────────────────────────────

  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints[1]?.clusters?.tuya;
    if (!tuya) { this.error('Tuya cluster not found on EP1'); return; }

    const dispatch = async (data) => {
      await this._processDatapoint(data).catch(e => this.error('DP dispatch error:', e));
    };

    tuya.on('reporting', dispatch);
    tuya.on('response',  dispatch);
    tuya.on('datapoint', dispatch);
    this.log('Tuya listeners attached');
  }

  // ─── Datapoint → capability / setting ────────────────────────────────────

  async _processDatapoint(data) {
    const value = this._parseDataValue(data);
    if (value === null || value === undefined) return;

    switch (data.dp) {

      // ── alarm active ──────────────────────────────────────────────────────
      case DP.ALARM:
        if (this.getCapabilityValue('onoff') !== value)
          await this.setCapabilityValue('onoff', value)
            .catch(e => this.error('alarm update:', e));
        // Device reports stopped → cancel auto-reset + fire deactivated trigger
        if (!value) {
          clearTimeout(this._alarmAutoResetTimer);
          this._alarmAutoResetTimer = null;
          this._triggerFlow('siren_deactivated', { reason: 'auto' });
        }
        this.log(`Alarm: ${value ? 'ON' : 'OFF'}`);
        break;

      // ── battery level ─────────────────────────────────────────────────────
      case DP.BATTERY:
        if (typeof value === 'number' && value >= 0 && value <= 100)
          await this.setCapabilityValue('measure_battery', value)
            .catch(e => this.error('battery update:', e));
        this.log(`Battery: ${value}%`);
        break;

      // ── volume (sync setting from device, wire 0-2 stored as "0"/"1"/"2") ──
      case DP.VOLUME:
        this._syncSetting('alarmvolume', String(value));
        this.log(`Volume: ${value}`);
        break;

      // ── duration (sync setting from device) ───────────────────────────────
      case DP.DURATION:
        this._syncSetting('alarmsoundtime', value);
        this.log(`Duration: ${value}s`);
        break;

      // ── melody (sync setting from device, wire 0-17 stored as "0"-"17") ───
      case DP.MELODY: {
        const name = MELODY_NAMES[value] ?? `Melody ${value}`;
        this._syncSetting('alarmtune', String(value));
        this._syncSetting('melody_name', name);
        this.log(`Melody: ${value} (${name})`);
        break;
      }
    }
  }

  // ─── Capability → device ──────────────────────────────────────────────────

  async _onCapabilityOnOff(value) {
    if (value) {
      await this._startSiren();
    } else {
      await this._stopSiren();
    }
  }

  /**
   * Start siren using current Settings values.
   * Sends melody + volume + duration before triggering.
   */
  async _startSiren() {
    const melody   = Number(this.getSetting('alarmtune')      ?? '5');
    const volume   = Number(this.getSetting('alarmvolume')    ?? '2');  // 2=high
    const duration = Number(this.getSetting('alarmsoundtime') ?? 10);

    await this._playSiren(melody, volume, duration);
  }

  /**
   * Play siren with explicit parameters (used by flow action).
   * @param {number} melody   Wire melody 0–17
   * @param {number} volume   Wire volume 0–2
   * @param {number} duration Seconds 1–1800
   */
  async _playSiren(melody, volume, duration) {
    this.log(`Siren: melody=${melody}, volume=${volume}, duration=${duration}s`);

    // Send configuration before triggering alarm
    await this.sendBulkCommands([
      { type: 'enum',   dp: DP.MELODY,   value: melody   },
      { type: 'enum',   dp: DP.VOLUME,   value: volume   },
      { type: 'data32', dp: DP.DURATION, value: duration },
    ], 200);

    // Trigger alarm
    await this.writeBool(DP.ALARM, true);

    // Schedule UI auto-reset (device does not send DP13=false automatically)
    if (duration > 0) {
      clearTimeout(this._alarmAutoResetTimer);
      this._alarmAutoResetTimer = this.homey.setTimeout(async () => {
        await this.setCapabilityValue('onoff', false).catch(() => {});
        this._triggerFlow('siren_deactivated', { reason: 'auto' });
        this._alarmAutoResetTimer = null;
        this.log('Siren auto-reset after duration');
      }, (duration + 2) * 1000);
    }

    this._triggerFlow('siren_activated', { duration });
    this.log('Siren started');
  }

  /**
   * Stop siren immediately.
   */
  async _stopSiren() {
    await this.writeBool(DP.ALARM, false);
    clearTimeout(this._alarmAutoResetTimer);
    this._alarmAutoResetTimer = null;
    this._triggerFlow('siren_deactivated', { reason: 'manual' });
    this.log('Siren stopped');
  }

  /**
   * Fire a device trigger flow card.
   */
  _triggerFlow(flowId, tokens = {}) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard(flowId);
      if (trigger) trigger.trigger(this, tokens, {});
    } catch (err) {
      this.error(`Flow trigger ${flowId} failed:`, err);
    }
  }

  // ─── Settings → device ────────────────────────────────────────────────────

  async onSettings({ changedKeys, newSettings }) {
    for (const key of changedKeys) {
      switch (key) {

        case 'alarmvolume': {
          const volume = Number(newSettings.alarmvolume);
          if (volume < 0 || volume > 2) throw new Error('Volume must be 0-2');
          await this.writeEnum(DP.VOLUME, volume)
            .catch(err => { this.error('Volume write:', err.message); throw err; });
          this.log(`Volume → ${volume}`);
          break;
        }

        case 'alarmsoundtime': {
          const duration = Number(newSettings.alarmsoundtime);
          if (duration < 1 || duration > 1800) throw new Error('Duration must be 1–1800s');
          await this.writeValue(DP.DURATION, duration)
            .catch(err => { this.error('Duration write:', err.message); throw err; });
          this.log(`Duration → ${duration}s`);
          break;
        }

        case 'alarmtune': {
          const melody = Number(newSettings.alarmtune);
          if (melody < 0 || melody > 17) throw new Error('Melody must be 0–17');
          await this.writeEnum(DP.MELODY, melody)
            .catch(err => { this.error('Melody write:', err.message); throw err; });
          const name = MELODY_NAMES[melody] ?? `Melody ${melody}`;
          this._syncSetting('melody_name', name);
          this.log(`Melody → ${melody} (${name})`);
          break;
        }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _syncSetting(key, value) {
    const current = this.getSetting(key);
    if (current != value) {
      this.setSettings({ [key]: value }).catch(e => this.error(`Setting sync ${key}:`, e));
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onDeleted() {
    clearTimeout(this._alarmAutoResetTimer);
    this._availability?.uninstall().catch(() => {});
    this.log('Ekaza Siren removed');
  }
}

module.exports = EkazaSiren;
