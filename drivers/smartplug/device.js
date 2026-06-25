'use strict';

/**
 * @file device.js
 * @description Smart Plug with Energy Metering (TS011F / TS0121)
 * Manufacturers: _TZ3000_88iqnhvd, _TZ3000_okaz9tjs, _TZ3210_cehuw1lw, _TZ3210_fgwhjm9j
 */

const { CLUSTER } = require('zigbee-clusters');
const { TuyaZclBase } = require('../../lib/TuyaZclBase');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { safeGetNumberSettings } = require('../../lib/settingsUtils');
const { isDeviceUnreachable } = require('../../lib/errorUtils');
const {
  normalizePowerOnState, normalizeIndicatorMode,
  powerOnSettingsPatch, indicatorSettingsPatch,
} = require('../../lib/ZclOnOffSettings');
const {
  SMART_PLUG_TIMEOUT_MS,
  SMART_PLUG_POLL_MIN_MS,
  SMART_PLUG_POLL_MAX_MS,
  SMART_PLUG_VOLTAGE_POLL_EVERY,
  SMART_PLUG_ENERGY_POLL_EVERY,
  ONOFF_REPORT_MAX_INTERVAL_S,
  APP_VERSION,
} = require('../../lib/constants');

const ENDPOINT_ID = 1;
const METERING_DIVISOR = 100.0;
const CURRENT_DIVISOR  = 1000;
const DEBOUNCE_TIME    = 500;
const POLL_MIN           = SMART_PLUG_POLL_MIN_MS;   // default poll period (ms)
const POLL_MAX           = SMART_PLUG_POLL_MAX_MS;   // offline backoff cap (ms)
const VOLTAGE_POLL_DIVISOR = SMART_PLUG_VOLTAGE_POLL_EVERY;
const ENERGY_POLL_DIVISOR  = SMART_PLUG_ENERGY_POLL_EVERY;


const TUYA_CONTROL_SETTINGS = [
  { key: 'relay_status',   attribute: 'powerOnStateGlobal' },
  { key: 'indicator_mode', attribute: 'indicatorMode'      },
  { key: 'child_lock',     attribute: 'childLock'          },
];

class SmartPlugDevice extends TuyaZclBase {

  constructor(...args) {
    super(...args);
    this._lastReportTime  = {};
    this._lastReportValue = {};
    this._lastVoltage     = 0;
    this._lastCurrent     = 0;
    this._pollTimer       = null;
    this._isPolling       = false;
    this._pollCycleCount  = 0;
    this._pollerActive    = false;
    this._pollFailCount   = 0;
    this._pollInterval    = POLL_MIN;   // base poll period (ms), overridden by settings
    this._pollBackoff     = POLL_MIN;   // current poll delay (ms), grows when offline
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  async onNodeInit({ zclNode }) {
    this.log(`Smart Plug v${APP_VERSION} - Init: ${this.getName()}`);

    this._gangLabel = 'Smart Plug';
    this._endpoint  = ENDPOINT_ID;

    await this._loadSettings();
    await this._addMissingCapabilities();
    this._registerCapabilities();

    await this._installAvailability();

    const startupJitter = 2000 + Math.random() * 6000;
    await new Promise(r => this.homey.setTimeout(r, startupJitter));

    const reachable = await this._safeReadAndSyncTuyaSettings();
    await this._safeSetupAttributeReporting();
    await this._readBasicAttributes(zclNode);
    this._attachOnOffListeners(zclNode);

    // Rejoin detection: the TS011F sends a spontaneous E001 (tuyaPowerOnState)
    // reportAttributes (cmd 0x0A) only on the power-restore boot — never on a setting
    // write (those echo on the onOff cluster) nor in steady state (verified on the
    // sniffer). The E001 cluster is NOT on this endpoint's cluster list, so the report
    // only surfaces at the raw-frame level — so we hook handleFrame like the ZBMINI.
    // _notifyRejoin's guards (120s boot / 30s cooldown) handle the app-restart dump and
    // burst dedup. This replaces the 3-source boot-burst path, which the plug's sparse
    // boot dump (childLock alone) can never reach.
    // Hook the SAME node the AvailabilityManager hooks — inbound frames flow through
    // homey.zigbee.getNode(this), NOT this.node (which never sees them). getNode is
    // awaited after _installAvailability, so node.handleFrame here is already the
    // availability wrapper; we wrap it once more (outermost) and call through.
    {
      const node = await this.homey.zigbee.getNode(this);
      const _hook = node.handleFrame.bind(node);
      node.handleFrame = (...args) => {
        const [, clusterId, frame] = args;
        if (clusterId === 0xE001 && Buffer.isBuffer(frame) && frame.length >= 3) {
          const mfrSpecific = frame[0] & 0x04;
          const cmdId = mfrSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
          if (cmdId === 0x0A) {
            this.log('[rejoin] E001 boot report — power restored');
            this._notifyRejoin();
          }
        }
        return _hook(...args);
      };
      this.log('[rejoin] E001 boot-frame hook installed');
    }

    this._bindSilentTimeCluster(zclNode);

    // tuyaE000 boot listener: inchingTime (0xD001) fires on reconnect/power-restore.
    // Since countdown is not implemented in Homey, this is a reliable zero-FP rejoin signal.
    this._attachTuyaBootListener(zclNode);

    // Always start polling regardless of boot reachability.
    // If the device was unreachable at init (Zigbee mesh still stabilising after app restart),
    // marking unavailable + stopping polling creates a deadlock: no polls go out, reporting
    // was never configured, so no frames arrive and the device stays stuck as unavailable.
    // The watchdog will mark it unavailable after SMART_PLUG_TIMEOUT_MS if truly offline.
    if (!reachable) {
      this.log('[Init] Device not reachable at boot — polling will confirm state');
    }
    this._pollBackoff = this._pollInterval;
    this._startPolling();

    this.log('Smart Plug initialized');
  }

  // ─── Base overrides ────────────────────────────────────────────────────

  async _installAvailability() {
    this._startedAt = Date.now(); // boot guard for _notifyRejoin (not set by super override)
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: SMART_PLUG_TIMEOUT_MS,
    });
    await this._availability.install();
  }

  // ─── Availability callbacks ────────────────────────────────────────────

  async onBecameAvailable() {
    this.log('[Polling] Device back online — resume base polling');
    await this._safeSetupAttributeReporting();
    this._resumeFastPolling();
  }

  async onBecameUnavailable(reason) {
    // Keep the poll loop alive so it can probe (with backoff) for the device's
    // return. The handleFrame hook / E001 boot frame are the primary recovery
    // signals; the backed-off poll is the fallback.
    this.log(`[Polling] Device offline (${reason}) — poll backing off`);
    this._startPolling(); // idempotent — ensure the loop is running
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  async _loadSettings() {
    this._energyFactor = parseFloat(this.getSetting('energyFactor')) || 1;
    this._powerFactor  = parseFloat(this.getSetting('powerFactor'))  || 1;
    this._calcPower    = this.getSetting('calcPower') === true;

    const intervals = await safeGetNumberSettings(this, {
      pollInterval:          { min: 60, max: 3600, fallback: POLL_MIN / 1000 },
    });

    this._pollInterval          = intervals.pollInterval * 1000;   // seconds → ms
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    await this._loadSettings();

    const onOff = this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff;
    for (const { key } of TUYA_CONTROL_SETTINGS) {
      if (!changedKeys.includes(key)) continue;
      try {
        const val = newSettings[key];
        if      (key === 'relay_status')   await onOff.setGlobalPowerOnState(val);
        else if (key === 'indicator_mode') await onOff.setIndicatorMode(val);
        else if (key === 'child_lock')     await onOff.setChildLock(val);
        this.log(`Setting written: ${key} = ${val}`);
      } catch (err) {
        this.error(`Failed to write ${key}:`, err.message);
        throw err;
      }
    }

    if (changedKeys.includes('pollInterval')) {
      this.log(`[Settings] Polling interval → ${this._pollInterval / 1000}s`);
      this._resumeFastPolling(); // apply the new base period immediately
    }
  }

  // ─── Capabilities ──────────────────────────────────────────────────────

  async _addMissingCapabilities() {
    for (const cap of ['measure_current', 'measure_voltage']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err => this.error(`addCapability ${cap}:`, err));
      }
    }
  }

  _registerCapabilities() {
    // Command path (Homey → device) goes through our availability-aware handler,
    // NOT the framework's default ZCL setter — so a failed write retries, marks the
    // plug unavailable, and stays quiet instead of throwing a raw frame stack.
    // The report path (device → Homey) is the attr.onOff listener in
    // _attachOnOffListeners, using the same debounce as before.
    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    this.registerCapability('meter_power', CLUSTER.METERING, {
      reportParser: raw => this._parseMeter(raw),
      getParser:    raw => this._parseMeter(raw),
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
        // Signal activity via zclNode path — guards against stale handleFrame hook
        // (Homey may replace the raw node object on rejoin, making the hook invisible).
        this._availability?.notifyActivity('measure_current').catch(() => {});
        return this._lastCurrent;
      },
      getOpts: { getOnStart: true },
    });

    this.registerCapability('measure_voltage', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => {
        this._lastVoltage = raw;
        this._updateCalculatedPower();
        this._availability?.notifyActivity('measure_voltage').catch(() => {});
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
      // Power is computed from V × I (these firmwares report activePower
      // unreliably — that's why calcPower exists). Zero current = zero power,
      // so once voltage is known we report a genuine 0 W instead of suppressing it.
      if (this._lastVoltage > 0) {
        return Math.round(this._lastVoltage * this._lastCurrent * this._powerFactor * 100) / 100;
      }
      // No voltage reading yet (early boot): suppress a spurious 0 W while the
      // device is ON until V/A populate; otherwise report 0.
      return (raw === 0 && this.getCapabilityValue('onoff') === true) ? null : 0;
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

  // ─── Capability → device (availability-aware) ──────────────────────────

  /**
   * Send the on/off command with availability-aware retry.
   *  - Online:  up to 3 attempts; persistent "unreachable" → mark unavailable.
   *  - Offline: a single quiet attempt (no retry) — mirrors the poll backoff so
   *    mashing a greyed-out device doesn't flood the log with frame stacks.
   * Never rethrows: a thrown capability listener surfaces as a raw [err] stack
   * from the SDK, which is exactly the noise this replaces.
   */
  async _onCapabilityOnOff(value) {
    const onOff = this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff;
    const offline = !this.getAvailable();
    const attempts = offline ? 1 : 3;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        if (value) await onOff.setOn();
        else       await onOff.setOff();
        if (i > 0) this.log(`[Smart Plug] command retry succeeded (attempt ${i + 1})`);
        return;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise(r => this.homey.setTimeout(r, 350));
      }
    }
    if (isDeviceUnreachable(lastErr)) {
      this.log(`[Smart Plug] command ${value ? 'ON' : 'OFF'} failed — device unreachable`);
      if (!offline) this._availability?.markUnavailable('Device unreachable').catch(() => {});
    } else {
      this.error('[Smart Plug] command failed:', lastErr.message);
    }
  }

  // ─── Manual polling engine ─────────────────────────────────────────────

  _startPolling() {
    if (this._pollerActive) return;
    this._pollerActive = true;
    this.log(`[Polling] Starting @ ${this._pollBackoff / 1000}s`);
    this._armPoll(this._pollBackoff);
  }

  /** (Re)arm a single poll timer after `delay` ms. Clears any pending timer first. */
  _armPoll(delay) {
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = this.homey.setTimeout(() => this._runPoll(), delay);
  }

  async _runPoll() {
    this._pollTimer = null;
    if (!this._pollerActive) return;
    await this._pollCycle();
    if (this._pollerActive) this._armPoll(this._pollBackoff);
  }

  _stopPolling() {
    if (!this._pollerActive && !this._pollTimer) return;
    this._pollerActive = false;
    if (this._pollTimer) {
      this.homey.clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this.log('[Polling] Stopped');
  }

  /** Jump back to the base poll cadence now (recovery / settings change). */
  _resumeFastPolling() {
    this._pollFailCount = 0;
    this._pollBackoff = this._pollInterval;
    if (this._pollerActive) this._armPoll(this._pollBackoff);
    else this._startPolling();
  }

  async _pollCycle() {
    if (this._isPolling) return;
    this._isPolling = true;
    try {
      const timeout = new Promise((_, reject) =>
        this.homey.setTimeout(() => reject(new Error('Poll timeout')), 20000));
      await Promise.race([this._pollMeasurements(), timeout]);

      // Reachable → reset to base cadence. The read responses also feed the
      // handleFrame hook, which restores availability if it was offline.
      this._pollFailCount = 0;
      this._pollBackoff = this._pollInterval;
      if (!this.getAvailable()) await this._availability?.notifyActivity('poll-recovery');
    } catch (err) {
      this._pollFailCount += 1;
      if (this.getAvailable()) {
        // Still online: keep base cadence, log quietly. After a couple of consecutive
        // misses (outside the boot-grace window, so mesh startup timing doesn't
        // false-trip), mark unavailable and begin backing off.
        this.log(`[Polling] Error (${this._pollFailCount}×): ${err.message}`);
        const pastBoot = Date.now() - (this._startedAt ?? 0) > 5 * 60 * 1000;
        if (this._pollFailCount >= 2 && pastBoot) {
          await this._availability?.markUnavailable('No response to polls').catch(() => {});
        }
      } else {
        // Already offline: exponential backoff up to the cap — quiet probing that
        // eases mesh congestion while the plug stays unreachable.
        const cap = Math.max(POLL_MAX, this._pollInterval);
        this._pollBackoff = Math.min(this._pollBackoff * 2, cap);
        this.log(`[Polling] Offline — next probe in ${Math.round(this._pollBackoff / 1000)}s`);
      }
    } finally {
      this._isPolling = false;
    }
  }

  async _pollMeasurements() {
    const ep = this.zclNode.endpoints[ENDPOINT_ID];

    this._pollCycleCount = (this._pollCycleCount + 1) % ENERGY_POLL_DIVISOR;

    await ep.clusters.onOff.readAttributes(['onOff'])
      .then(r => {
        if (r.onOff !== undefined)
          this.setCapabilityValue('onoff', Boolean(r.onOff)).catch(this.error);
      })
      .catch(err => { throw err; });

    const elAttrNames = ['activePower', 'rmsCurrent'];
    if (this._pollCycleCount % VOLTAGE_POLL_DIVISOR === 0) elAttrNames.push('rmsVoltage');

    const em = await ep.clusters.electricalMeasurement.readAttributes(elAttrNames);

    if (em.activePower !== undefined) {
      let w = this._parsePower(em.activePower);
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

    if (this._pollCycleCount === 0) {
      const mt = await ep.clusters.metering.readAttributes(['currentSummationDelivered']);
      if (mt.currentSummationDelivered !== undefined) {
        await this.setCapabilityValue('meter_power', this._parseMeter(mt.currentSummationDelivered)).catch(this.error);
      }
    }
  }

  // ─── Live attribute listeners ──────────────────────────────────────────

  _attachOnOffListeners(zclNode) {
    const onOff = zclNode.endpoints[1].clusters.onOff;

    // Report path (device → Homey): same debounce the old reportParser used.
    onOff.on('attr.onOff', value => {
      const v = this._debouncedParser('onoff', value);
      if (v === null) return;
      this.setCapabilityValue('onoff', v).catch(this.error);
    });

    onOff.on('attr.childLock', value => {
      this._trackBootBurst('childLock');
      this.setSettings({ child_lock: Boolean(value) }).catch(() => {});
    });

    onOff.on('attr.indicatorMode', value => {
      this._trackBootBurst('indicatorMode');
      this.setSettings(indicatorSettingsPatch('indicator_mode', 'indicator_mode_current', value)).catch(() => {});
    });

    onOff.on('attr.powerOnStateGlobal', value => {
      this._trackBootBurst('powerOnGlobal');
      this.setSettings(powerOnSettingsPatch('relay_status', 'relay_status_current', value)).catch(() => {});
      // Note: rejoin no longer fires on a single attribute. _trackBootBurst requires
      // 3+ DISTINCT config attributes within ~2s (a reboot dump), so a lone periodic
      // powerOnStateGlobal report from TS011F firmware does not trigger device_rejoined.
    });
  }

  // ─── Tuya attribute read / configure ───────────────────────────────────

  async _safeReadAndSyncTuyaSettings() {
    try {
      const attrs = await this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff
        .readAttributes(['powerOnStateGlobal', 'indicatorMode', 'childLock']);

      const update = {};
      if (attrs.powerOnStateGlobal !== undefined)
        Object.assign(update, powerOnSettingsPatch('relay_status', 'relay_status_current', attrs.powerOnStateGlobal));
      if (attrs.indicatorMode !== undefined)
        Object.assign(update, indicatorSettingsPatch('indicator_mode', 'indicator_mode_current', attrs.indicatorMode));
      if (attrs.childLock !== undefined) update.child_lock = Boolean(attrs.childLock);

      if (Object.keys(update).length > 0) await this.setSettings(update);
      return true;
    } catch (err) {
      if (err.message && err.message.includes('Could not reach device')) {
        this.log('Device not reachable at init (not powered)');
        return false;
      }
      this.log('Could not read device settings (device may not support it):', err.message);
      return true;
    }
  }

  async _safeSetupAttributeReporting() {
    try {
      await this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff.configureReporting({
        onOff: { minInterval: 0, maxInterval: ONOFF_REPORT_MAX_INTERVAL_S, minChange: 1 },
      });
    } catch (err) {
      this.log('Could not configure onOff reporting:', err.message);
    }

    this.log('ElectricalMeasurement uses polling/backoff; passive reports will still be handled');
  }

  // ─── Debounce ──────────────────────────────────────────────────────────

  _debouncedParser(capability, value) {
    const now       = Date.now();
    const lastTime  = this._lastReportTime[capability]  || 0;
    const lastValue = this._lastReportValue[capability];

    if (lastValue === value && (now - lastTime) < DEBOUNCE_TIME) return null;

    this._lastReportTime[capability]  = now;
    this._lastReportValue[capability] = value;
    return value;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  // _teardown is invoked by both onUninit (re-init/restart) and onDeleted
  // (user removal) via TuyaZclBase. Stopping polling here prevents a leaked
  // interval + orphaned availability hook on app restart.
  async _teardown() {
    this._stopPolling();
    await super._teardown();
  }

  onDeleted() {
    super.onDeleted();
    this.log(`Smart Plug v${APP_VERSION} removed`);
  }
}

module.exports = SmartPlugDevice;
