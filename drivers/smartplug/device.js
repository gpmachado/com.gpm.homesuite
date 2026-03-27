'use strict';

/**
 * @file device.js
 * @description Smart Plug with Energy Metering (TS011F / TS0121)
 * Manufacturers: _TZ3000_88iqnhvd, _TZ3000_okaz9tjs, _TZ3210_cehuw1lw, _TZ3210_fgwhjm9j
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const ExtendedOnOffCluster = require('../../lib/ExtendedOnOffCluster');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const {
  SMART_PLUG_TIMEOUT_MS,
  SMART_PLUG_POLL_MIN_MS,
  SMART_PLUG_VOLTAGE_POLL_EVERY,
  SMART_PLUG_ENERGY_POLL_EVERY,
  SMART_PLUG_REPORT_POWER_DEFAULT_S,
  SMART_PLUG_REPORT_CURRENT_DEFAULT_S,
  SMART_PLUG_REPORT_VOLTAGE_DEFAULT_S,
  SMART_PLUG_REPORT_INTERVAL_MIN_S,
  ONOFF_REPORT_MAX_INTERVAL_S,
  APP_VERSION,
} = require('../../lib/constants');

const DRIVER_NAME = 'Smart Plug';

const ENDPOINT_ID = 1;
const METERING_DIVISOR = 100.0;   // Wh -> kWh
const CURRENT_DIVISOR = 1000;    // mA -> A
const DEBOUNCE_TIME = 500;       // ms

// ─── Poll intervals — defined in lib/constants.js ────────────────────────────
const POLL_MIN = SMART_PLUG_POLL_MIN_MS;

const VOLTAGE_POLL_DIVISOR = SMART_PLUG_VOLTAGE_POLL_EVERY;
const ENERGY_POLL_DIVISOR  = SMART_PLUG_ENERGY_POLL_EVERY;

// Settings use enum strings directly matching ExtendedOnOffCluster attribute values:
//   relay_status   → 'off' | 'on' | 'lastState'  (powerOnStateGlobal)
//   indicator_mode → 'off' | 'status' | 'position' (indicatorMode)
//   child_lock     → boolean                        (childLock)
const RELAY_STATUS_LABELS  = { off: 'Always off', on: 'Always on', lastState: 'Remember last state' };
const INDICATOR_MODE_LABELS = { off: 'Always off', status: 'On when powered', position: 'Off when powered' };

const TUYA_CONTROL_SETTINGS = [
  { key: 'relay_status',   attribute: 'powerOnStateGlobal' },
  { key: 'indicator_mode', attribute: 'indicatorMode'      },
  { key: 'child_lock',     attribute: 'childLock'          },
];

class SmartPlugDevice extends ZigBeeDevice {

  constructor(...args) {
    super(...args);

    // Report debounce
    this._lastReportTime = {};
    this._lastReportValue = {};

    // Electrical cache for calcPower
    this._lastVoltage = 0;
    this._lastCurrent = 0;

    // Availability manager reference
    this._availability = null;

    // ─── Polling state ──────────────────────────────────────────────────
    this._pollTimer = null;
    this._isPolling = false;
    this._pollCycleCount = 0;
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${APP_VERSION} - Init: ${this.getName()}`);

    this._loadSettings();
    await this._addMissingCapabilities();
    this._registerCapabilities();

    const reachable = await this._safeReadAndSyncTuyaSettings();
    // Stagger attribute reporting setup across devices to avoid mesh congestion on startup.
    const startupJitter = 2000 + Math.random() * 6000; // 2–8 s
    await new Promise(r => this.homey.setTimeout(r, startupJitter));
    await this._safeSetupAttributeReporting();
    await this._safeReadDeviceInfo(zclNode);
    this._attachOnOffListeners(zclNode);

    // Silently absorb Time cluster requests on endpoint 1
    try {
      if (zclNode.endpoints[1].clusters.time) {
        zclNode.endpoints[1].clusters.time.on('attr.time', () => { });
        zclNode.endpoints[1].clusters.time.on('unhandled', () => { });
      }
    } catch (err) { }

    // Passive availability: handleFrame hook fires on every inbound Zigbee frame,
    // including poll responses. onBecameAvailable / onBecameUnavailable below
    // connect availability state directly to the polling engine.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: SMART_PLUG_TIMEOUT_MS,
    });
    await this._availability.install();

    if (reachable) {
      // Device responded at init — start polling immediately.
      this._startPolling();
    } else {
      // Device didn't respond at boot (unplugged). Mark offline now instead of
      // waiting for the 10-min AvailabilityManager heartbeat timeout.
      // Polling will be started by onBecameAvailable() when the device rejoins.
      this.log('[Init] Device offline at boot — skipping poll start');
      await this.setUnavailable('Device not reachable').catch(() => {});
    }

    this.log(`${DRIVER_NAME} initialized`);
  }

  // ─── Availability callbacks ────────────────────────────────────────────

  /**
   * Called by AvailabilityManagerCluster0 (via _markAllAvailable) when the device
   * recovers from offline — setAvailable() was already called by the manager.
   * Restarts the polling engine.
   */
  async onBecameAvailable() {
    this.log('[Polling] Device back online — restart polling');
    this._stopPolling();
    this._startPolling();
  }

  /**
   * Called by AvailabilityManagerCluster0 (via _markAllUnavailable) when the
   * device times out — setUnavailable() was already called by the manager.
   * Stops the polling engine to avoid flooding the mesh with doomed requests.
   */
  async onBecameUnavailable(reason) {
    this.log(`[Polling] Device offline (${reason}) — stop polling`);
    this._stopPolling();
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  _loadSettings() {
    this._energyFactor = parseFloat(this.getSetting('energyFactor')) || 1;
    this._powerFactor  = parseFloat(this.getSetting('powerFactor'))  || 1;
    this._calcPower    = this.getSetting('calcPower') === true;

    this._reportIntervalPower   = Math.max(SMART_PLUG_REPORT_INTERVAL_MIN_S, parseInt(this.getSetting('reportIntervalPower'),   10) || SMART_PLUG_REPORT_POWER_DEFAULT_S);
    this._reportIntervalCurrent = Math.max(SMART_PLUG_REPORT_INTERVAL_MIN_S, parseInt(this.getSetting('reportIntervalCurrent'), 10) || SMART_PLUG_REPORT_CURRENT_DEFAULT_S);
    this._reportIntervalVoltage = Math.max(SMART_PLUG_REPORT_INTERVAL_MIN_S, parseInt(this.getSetting('reportIntervalVoltage'), 10) || SMART_PLUG_REPORT_VOLTAGE_DEFAULT_S);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this._loadSettings();

    for (const { key, attribute } of TUYA_CONTROL_SETTINGS) {
      if (!changedKeys.includes(key)) continue;
      try {
        const val = newSettings[key];
        await this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff
          .writeAttributes({ [attribute]: val });
        this.log(`Setting written: ${key} = ${val}`);
      } catch (err) {
        this.error(`Failed to write ${key}:`, err.message);
        throw err;
      }
    }

    const intervalKeys = ['reportIntervalPower', 'reportIntervalCurrent', 'reportIntervalVoltage'];
    if (intervalKeys.some(k => changedKeys.includes(k))) {
      this.log('[Settings] Reporting intervals changed — reconfiguring');
      await this._safeSetupAttributeReporting();
    }
  }

  // ─── Capabilities ──────────────────────────────────────────────────────

  async _addMissingCapabilities() {
    for (const cap of ['measure_current', 'measure_voltage']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err =>
          this.error(`addCapability ${cap}:`, err));
      }
    }
  }

  _registerCapabilities() {
    // All capabilities: getOnStart only -- no SDK pollInterval.
    // The manual engine owns all periodic polling.
    //
    // onoff: physical button presses arrive as ZCL attribute reports from the
    // device and are handled by reportParser without any BoundCluster.

    this.registerCapability('onoff', ExtendedOnOffCluster, {
      reportParser: value => this._debouncedParser('onoff', value),
      getOpts: { getOnStart: true },
    });

    this.registerCapability('meter_power', CLUSTER.METERING, {
      reportParser: raw => this._parseMeter(raw),
      getParser: raw => this._parseMeter(raw),
      getOpts: { getOnStart: true },
    });

    this.registerCapability('measure_power', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => this._parsePower(raw),
      getOpts: { getOnStart: true },
    });

    this.registerCapability('measure_current', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => {
        this._lastCurrent = raw / CURRENT_DIVISOR;
        this._updateCalculatedPower();
        return this._lastCurrent;
      },
      getOpts: { getOnStart: true },
    });

    this.registerCapability('measure_voltage', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => {
        this._lastVoltage = raw;
        this._updateCalculatedPower();
        return raw;
      },
      getOpts: { getOnStart: true },
    });
  }

  // ─── Parsers ───────────────────────────────────────────────────────────

  _parseMeter(raw) {
    const kWh = (raw / METERING_DIVISOR) * this._energyFactor;
    return Math.round(kWh * 1000) / 1000;
  }

  _parsePower(raw) {
    if (this._calcPower) {
      return (this._lastVoltage > 0 && this._lastCurrent > 0)
        ? Math.round(this._lastVoltage * this._lastCurrent * this._powerFactor * 100) / 100
        : 0;
    }
    return raw * this._powerFactor;
  }

  _updateCalculatedPower() {
    if (!this._calcPower) return;
    if (this._lastVoltage > 0 && this._lastCurrent > 0) {
      const power = Math.round(this._lastVoltage * this._lastCurrent * this._powerFactor * 100) / 100;
      this.setCapabilityValue('measure_power', power).catch(this.error);
    }
  }

  // ─── Manual polling engine ─────────────────────────────────────────────

  /** Start the polling timer. No-op if already running. */
  _startPolling() {
    if (this._pollTimer) return;
    this.log(`[Polling] Starting @ ${POLL_MIN / 1000}s`);
    this._pollTimer = this.homey.setInterval(() => this._pollCycle(), POLL_MIN);
  }

  /** Stop and clear the polling timer. No-op if already stopped. */
  _stopPolling() {
    if (!this._pollTimer) return;
    this.homey.clearInterval(this._pollTimer);
    this._pollTimer = null;
    this.log('[Polling] Stopped');
  }

  /**
   * Single poll cycle — guarded against re-entry and offline state.
   * Errors are logged but do not stop the timer; the AvailabilityManager
   * calls _stopPolling() when the device is truly offline.
   *
   * A 20 s hard timeout prevents ZCL requests from accumulating in the
   * Zigbee protocol stack when the device is unreachable (avoids stack overflow).
   */
  async _pollCycle() {
    if (this._isPolling) return;
    if (!this.getAvailable()) return;

    this._isPolling = true;
    try {
      const timeout = new Promise((_, reject) =>
        this.homey.setTimeout(() => reject(new Error('Poll timeout')), 20000));
      await Promise.race([this._pollMeasurements(), timeout]);
    } catch (err) {
      this.log(`[Polling] Error: ${err.message}`);
    } finally {
      this._isPolling = false;
    }
  }

  /**
   * Read all measurements from the device sequentially.
   *
   * Sequential (not Promise.all) to avoid bursting multiple ZCL requests
   * simultaneously -- important for mesh stability in dense deployments.
   *
   * Poll cadence (base interval POLL_MIN = 2 min):
   *   Every cycle  : onOff, activePower, rmsCurrent (~2 min)
   *   Every 5th    : rmsVoltage (~10 min, stable)
   *   Every 10th   : currentSummationDelivered / kWh (~20 min, very slow)
   *
   * NOTE: capability values are set directly from readAttributes() return values.
   * We do NOT rely on attr.* events from registerCapability — that only handles
   * unsolicited attribute reports. readAttributes() may or may not emit attr.*
   * depending on the zigbee-clusters version; setting directly is reliable.
   */
  async _pollMeasurements() {
    const ep = this.zclNode.endpoints[ENDPOINT_ID];

    this._pollCycleCount = (this._pollCycleCount + 1) % ENERGY_POLL_DIVISOR;

    // onOff: every cycle — registerCapability handles the attr.onOff event for
    // unsolicited reports; here we just want the current state at boot/reconnect.
    await ep.clusters.onOff.readAttributes(['onOff'])
      .then(r => {
        if (r.onOff !== undefined)
          this.setCapabilityValue('onoff', Boolean(r.onOff)).catch(this.error);
      })
      .catch(err => { throw err; });

    // ElectricalMeasurement: every cycle (+ rmsVoltage every 5th).
    // Sniffer-confirmed: _TZ3000_okaz9tjs responds to readAttributes for 0x0505/0x0508/0x050b.
    // configureAttributeReporting fails (UNREPORTABLE_ATTRIBUTE) but polling works on all variants.
    const elAttrNames = ['activePower', 'rmsCurrent'];
    if (this._pollCycleCount % VOLTAGE_POLL_DIVISOR === 0) elAttrNames.push('rmsVoltage');

    const em = await ep.clusters.electricalMeasurement.readAttributes(elAttrNames);

    if (em.activePower !== undefined) {
      let w = this._parsePower(em.activePower);
      // activePower is integer watts (÷1), so sub-watt standby loads round to 0.
      // Fallback to apparent power (V×I) so the tile shows a non-zero indicator.
      // Does NOT affect Homey Energy totals — those come from meter_power (kWh).
      if (w === 0 && em.rmsCurrent !== undefined && em.rmsCurrent > 20 && this._lastVoltage > 0) {
        w = Math.round(this._lastVoltage * (em.rmsCurrent / CURRENT_DIVISOR) * 10) / 10;
      }
      if (w > 0) this.log(`[Poll] power=${w}W current=${em.rmsCurrent !== undefined ? em.rmsCurrent / CURRENT_DIVISOR : '-'}A${em.rmsVoltage !== undefined ? ` voltage=${em.rmsVoltage}V` : ''}`);
      await this.setCapabilityValue('measure_power', w).catch(this.error);
    }
    if (em.rmsCurrent !== undefined) {
      this._lastCurrent = em.rmsCurrent / CURRENT_DIVISOR;
      await this.setCapabilityValue('measure_current', this._lastCurrent).catch(this.error);
      this._updateCalculatedPower();
    }
    if (em.rmsVoltage !== undefined) {
      this._lastVoltage = em.rmsVoltage;
      await this.setCapabilityValue('measure_voltage', this._lastVoltage).catch(this.error);
      this._updateCalculatedPower();
    }

    // kWh: every ENERGY_POLL_DIVISOR cycles
    if (this._pollCycleCount === 0) {
      const mt = await ep.clusters.metering.readAttributes(['currentSummationDelivered']);
      if (mt.currentSummationDelivered !== undefined) {
        await this.setCapabilityValue('meter_power', this._parseMeter(mt.currentSummationDelivered)).catch(this.error);
      }
    }
  }

  // ─── Live attribute listeners ──────────────────────────────────────────

  /**
   * Listen for unsolicited onOff attribute reports — device may report changes
   * made via Tuya app after init (childLock, indicatorMode, powerOnStateGlobal
   * are software-only settings, not changeable physically).
   */
  _attachOnOffListeners(zclNode) {
    const onOff = zclNode.endpoints[1].clusters.onOff;

    onOff.on('attr.childLock', value => {
      this.setSettings({ child_lock: Boolean(value) }).catch(() => {});
    });

    onOff.on('attr.indicatorMode', value => {
      const norm = { 0: 'off', 1: 'status', 2: 'position' };
      const v = (typeof value === 'string') ? value : (norm[value] ?? String(value));
      this.setSettings({
        indicator_mode:         v,
        indicator_mode_current: INDICATOR_MODE_LABELS[v] ?? v,
      }).catch(() => {});
    });

    onOff.on('attr.powerOnStateGlobal', value => {
      const map = { 0: 'off', 1: 'on', 2: 'lastState' };
      const v = map[value] ?? String(value);
      this.setSettings({
        relay_status:         v,
        relay_status_current: RELAY_STATUS_LABELS[v] ?? v,
      }).catch(() => {});
    });
  }

  // ─── Tuya attribute read / configure ───────────────────────────────────

  /**
   * Reads Tuya settings from the device and syncs them to Homey.
   * Returns true if the device responded (reachable), false if it couldn't be reached.
   * Other errors (unsupported attributes, etc.) are logged and treated as reachable.
   */
  async _safeReadAndSyncTuyaSettings() {
    try {
      const attrs = await this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff
        .readAttributes(['powerOnStateGlobal', 'indicatorMode', 'childLock']);

      const update = {};
      // Store enum strings directly — matches dropdown IDs in driver.settings.compose.json.
      // indicatorMode arrives as uint8 (0/1/2) from the device; normalise to string enum.
      const INDICATOR_NORM = { 0: 'off', 1: 'status', 2: 'position' };
      if (attrs.powerOnStateGlobal !== undefined) {
        const val = attrs.powerOnStateGlobal;
        update.relay_status         = val;
        update.relay_status_current = RELAY_STATUS_LABELS[val] ?? String(val);
      }
      if (attrs.indicatorMode !== undefined) {
        const normalized = (typeof attrs.indicatorMode === 'string')
          ? attrs.indicatorMode
          : (INDICATOR_NORM[attrs.indicatorMode] ?? String(attrs.indicatorMode));
        update.indicator_mode         = normalized;
        update.indicator_mode_current = INDICATOR_MODE_LABELS[normalized] ?? normalized;
      }
      if (attrs.childLock !== undefined) update.child_lock = Boolean(attrs.childLock);

      if (Object.keys(update).length > 0) {
        await this.setSettings(update);
      }
      return true;
    } catch (err) {
      if (err.message && err.message.includes('Could not reach device')) {
        this.log('Device not reachable at init (not powered)');
        return false;
      }
      this.log('Could not read device settings (device may not support it):', err.message);
      return true; // reachable but attribute unsupported — polling should still run
    }
  }

  async _safeSetupAttributeReporting() {
    // onOff — physical button presses must arrive as reports
    try {
      await this.configureAttributeReporting([{
        endpointId: ENDPOINT_ID,
        cluster: ExtendedOnOffCluster,
        attributeName: 'onOff',
        minInterval: 0,
        maxInterval: ONOFF_REPORT_MAX_INTERVAL_S,
        minChange: 1,
      }]);
    } catch (err) {
      this.log('Could not configure onOff reporting:', err.message);
    }

    // ElectricalMeasurement — some TS011F variants (e.g. _TZ3210_fgwhjm9j) support
    // attribute reporting; others (_TZ3000_okaz9tjs) return UNREPORTABLE_ATTRIBUTE.
    // We call configureReporting() directly on the cluster (bypassing the SDK
    // wrapper that logs a verbose stack trace before rethrowing) so we control
    // the error output ourselves.
    // Polling engine is kept as fallback for devices that don't support this.
    try {
      const emCluster = this.zclNode.endpoints[ENDPOINT_ID].clusters.electricalMeasurement;
      await emCluster.configureReporting({
        activePower: { minInterval: 5,  maxInterval: this._reportIntervalPower,   minChange: 0 },
        rmsCurrent:  { minInterval: 5,  maxInterval: this._reportIntervalCurrent, minChange: 0 },
        rmsVoltage:  { minInterval: 10, maxInterval: this._reportIntervalVoltage, minChange: 1 },
      });
      this.log(`ElectricalMeasurement reporting configured — power:${this._reportIntervalPower}s current:${this._reportIntervalCurrent}s voltage:${this._reportIntervalVoltage}s`);
    } catch (err) {
      this.log(`ElectricalMeasurement reporting not supported (${err.message}) — polling will be used`);
    }
  }

  async _safeReadDeviceInfo(zclNode) {
    try {
      const info = await zclNode.endpoints[ENDPOINT_ID].clusters.basic
        .readAttributes(['manufacturerName', 'modelId', 'swBuildId', 'appVersion', 'powerSource']);

      this.log('Device info:', {
        name:             this.getName(),
        manufacturerName: info.manufacturerName,
        modelId:          info.modelId,
        swBuildId:        info.swBuildId,
        appVersion:       info.appVersion,
        powerSource:      info.powerSource,
      });

      if (info.swBuildId) await this.setStoreValue('firmwareVersion', info.swBuildId).catch(() => { });
      await this.setStoreValue('driverVersion', APP_VERSION).catch(() => { });
    } catch {
      // Basic cluster read optional — non-fatal
    }
  }

  // ─── Debounce ──────────────────────────────────────────────────────────

  _debouncedParser(capability, value) {
    const now = Date.now();
    const lastTime = this._lastReportTime[capability] || 0;
    const lastValue = this._lastReportValue[capability];

    if (lastValue === value && (now - lastTime) < DEBOUNCE_TIME) return null;

    this._lastReportTime[capability] = now;
    this._lastReportValue[capability] = value;
    return value;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  onDeleted() {
    this._stopPolling();
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} v${APP_VERSION} removed`);
  }
}

module.exports = SmartPlugDevice;
