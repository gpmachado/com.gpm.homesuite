'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { AvailabilityManagerCluster0 } = require('./AvailabilityManager');
const { readAttrCatch } = require('./errorUtils');
const { getNodeDevices, updateSiblingNames } = require('./connectedDevices');
const OnOffBoundCluster = require('./OnOffBoundCluster');
const { HEARTBEAT_TIMEOUT_MS, ONOFF_REPORT_MAX_INTERVAL_S } = require('./constants');
const {
  normalizePowerOnState, normalizeIndicatorMode,
  POWER_ON_DISPLAY, powerOnSettingsPatch,
  getPowerOnLabel, applyJitter, INDICATOR_LABELS,
} = require('./ZclOnOffSettings');

const SWITCH_DISPLAY   = { toggle: 'Toggle (Standard)', momentary: 'Momentary (Pulse)' };
const SWITCH_NORMALIZE = v => (v === 'toggle' || v === 'momentary') ? v : 'toggle';

// ─────────────────────────────────────────────────────────────────────────────

class TuyaZclBase extends ZigBeeDevice {

  // ── Sibling helpers ─────────────────────────────────────────────────────────

  /** All Homey device instances sharing this physical Zigbee node. */
  _getNodeDevices() {
    return getNodeDevices(this);
  }

  // ── ZCL on/off setup ────────────────────────────────────────────────────────

  /**
   * Wire up attr.onOff listener + OnOffBoundCluster binding + capability listener
   * for this._endpoint. Returns the onOff cluster for further listener attachment.
   * Requires this._endpoint and this._gangLabel to be set before calling.
   */
  _setupOnOffEndpoint(zclNode) {
    const ep = zclNode.endpoints[this._endpoint];
    const onOffCluster = ep.clusters.onOff;

    onOffCluster.on('attr.onOff', value => {
      this.log(`[${this._gangLabel}] attr.onOff: ${value}`);
      this.setCapabilityValue('onoff', value)
        .catch(err => this.error(`[${this._gangLabel}] setCapabilityValue onoff:`, err));
    });

    try {
      ep.bind('onOff', new OnOffBoundCluster({
        onSetOn:  () => { this.log(`[${this._gangLabel}] bound setOn`);  this.setCapabilityValue('onoff', true).catch(() => {}); },
        onSetOff: () => { this.log(`[${this._gangLabel}] bound setOff`); this.setCapabilityValue('onoff', false).catch(() => {}); },
        onToggle: () => { this.log(`[${this._gangLabel}] bound toggle`); this.setCapabilityValue('onoff', !this.getCapabilityValue('onoff')).catch(() => {}); },
      }));
    } catch (err) {
      this.log(`[${this._gangLabel}] OnOffBoundCluster bind failed:`, err.message);
    }

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));
    return onOffCluster;
  }

  /**
   * Attach tuyaE000 boot/reconnect listener for power-restore detection.
   *
   * Tuya firmware reports inchingTime (0xD001) on every reconnect (power restore).
   * Since countdown is NOT implemented in Homey (flows are used instead), inchingTime
   * ONLY fires on device power restore — a reliable rejoin signal with zero false
   * positives in this deployment.
   *
   * The 120 s boot guard in _notifyRejoin() prevents false positives on app restart.
   * The 30 s cooldown deduplicates bursts from the same rejoin event.
   *
   * Also suppresses inchingRemain (0xD002) noise (no handler needed).
   * Call on the main/single-gang device only (EP1 is the only endpoint with tuyaE000).
   */
  _attachTuyaBootListener(zclNode) {
    try {
      const cluster = zclNode.endpoints[1]?.clusters?.tuyaE000;
      if (!cluster) return;
      this.log('[Init] tuyaE000 boot listener attached');
      cluster.on('attr.inchingTime', () => this._trackBootBurst('inchingTime'));
      cluster.on('attr.inchingRemain', () => this._trackBootBurst('inchingRemain'));
      // Per-gang inching list (0xD003): the device reports the full list on boot
      // (power-restore dump) and after any change. Decode and re-sync each gang's
      // settings to the device's actual state. setSettings() does NOT trigger
      // onSettings, so there is no write-back loop.
      cluster.on('attr.inchingList', (b64) => {
        this._trackBootBurst('inchingList');
        try {
          const TuyaE000Cluster = require('./TuyaE000Cluster');
          const list = TuyaE000Cluster.decodeInching(b64);
          this.log('[tuyaE000] inchingList →', JSON.stringify(list));
          const devices = this._getNodeDevices();
          list.forEach(rec => {
            const dev = devices.find(d => d._endpoint === rec.gang);
            if (dev) dev.setSettings({
              inching_enabled: rec.enable,
              inching_time: rec.time,
            }).catch(() => {});
          });
        } catch (err) { this.error('[tuyaE000] inchingList decode failed:', err.message); }
      });
    } catch {}
  }

  /** @deprecated Use _attachTuyaBootListener instead. */
  _suppressTuyaE000(zclNode) { this._attachTuyaBootListener(zclNode); }

  /**
   * Build the per-gang inching list from every sibling's settings and write it to
   * EP1 (tuyaE000 is EP1-only; the list is global but covers all gangs). Callable
   * from any gang sub-device — the shared zclNode exposes EP1.
   *
   * During onSettings the changed device's new values are not committed yet, so
   * pass `selfOverride = { enable, time }` (from newSettings) for the caller.
   *
   * @param {{enable:boolean, time:number}|null} selfOverride  time in seconds
   */
  async _applyInching(selfOverride = null) {
    const TuyaE000Cluster = require('./TuyaE000Cluster');
    const records = this._getNodeDevices()
      .filter(d => d._endpoint)
      .map(d => {
        const s = (d === this && selfOverride) ? selfOverride : {
          enable: !!d.getSetting('inching_enabled'),
          time:   Number(d.getSetting('inching_time')) || 0,
        };
        return {
          gang:   d._endpoint,
          enable: !!s.enable,
          time:   Math.min(3600, Math.max(0, Number(s.time) || 0)),
        };
      })
      .sort((a, b) => a.gang - b.gang);

    const b64 = TuyaE000Cluster.encodeInching(records);
    this.log('[tuyaE000] setInching →', JSON.stringify(records), b64);
    await this.zclNode.endpoints[1].clusters.tuyaE000
      .setInching({ data: Buffer.from(b64, 'ascii') })
      .catch(err => this.error('[tuyaE000] setInching failed:', err.message));
  }

  // ── Backlight ───────────────────────────────────────────────────────────────

  /** Persist device backlight state to the backlight_enabled setting. */
  _applyBacklight(isOn) {
    this.setSettings({ backlight_enabled: !!isOn }).catch(() => {});
  }

  /**
   * Attach attr.backlightControl listener on onOffCluster (EP1).
   * Race-condition guard: device always reports ON after power restore even when
   * user preference is OFF — re-enforce without flipping the setting back to true.
   */
  _attachBacklightListener(onOffCluster) {
    onOffCluster.on('attr.backlightControl', value => {
      this._trackBootBurst('backlight');
      const isOn = (value === 'on' || value === 1 || value === true);
      if (isOn && !this.getSetting('backlight_enabled')) {
        // Debounce: device firmware can report backlightControl=on multiple times
        // in quick succession on rejoin (or continuously on some hardware variants
        // where the LED is hardwired to the relay). Re-enforce at most once per 20s.
        // Silent skip during debounce window — avoids log noise on stubborn devices.
        const now = Date.now();
        if (this._lastBacklightEnforceTs && (now - this._lastBacklightEnforceTs) < 20_000) {
          return;
        }
        this._lastBacklightEnforceTs = now;
        this.log('[EP1] backlightControl: on — user wants OFF, re-enforcing');
        onOffCluster.setBacklight(false)
          .catch(err => this.error('Error re-enforcing backlight off:', err));
        return;
      }
      this.log('[EP1] backlightControl:', value);
      this._applyBacklight(isOn);
    });
  }

  /**
   * Attach attr.powerOnStateGlobal listener on onOffCluster (EP1).
   * powerOnStateGlobal is uint8 — device reports raw numbers 0/1/2.
   * Also re-enforces backlight OFF after power restore if backlight_enabled = false.
   *
   * @param {object} onOffCluster
   * @param {string} behaviorKey  dropdown setting key (e.g. 'power_on_behavior_global')
   * @param {string} currentKey   label   setting key (e.g. 'power_on_current_global')
   */
  _attachPowerOnGlobalListener(onOffCluster, behaviorKey, currentKey) {
    onOffCluster.on('attr.powerOnStateGlobal', value => {
      this._trackBootBurst('powerOnGlobal');
      this.log('[EP1] powerOnStateGlobal:', value);
      this.setSettings(powerOnSettingsPatch(behaviorKey, currentKey, value))
        .catch(err => this.error('setSettings powerOnStateGlobal:', err));
    });
  }

  /**
   * Read backlightControl + powerOnStateGlobal from EP1 — first pairing only.
   * On normal boot these reads always fail (mesh timing); all state is covered by:
   *   - attr listeners (live reports on rejoin)
   *   - onEndDeviceAnnounce (backlight re-enforcement after power loss)
   *   - non-volatile memory on device (powerOn/switchMode survive power loss)
   */
  async _readExtendedOnOffAttrs(onOffCluster, behaviorKey, currentKey) {
    if (!this.isFirstInit() && this.getSetting(behaviorKey)) return;

    await onOffCluster
      .readAttributes(['backlightControl', 'powerOnStateGlobal'])
      .then(attrs => {
        this.log('[EP1] read onOff extended:', attrs);
        const s = {};
        if (attrs.backlightControl != null) {
          const isOn = (attrs.backlightControl === 'on' || attrs.backlightControl === 1 || attrs.backlightControl === true);
          const willForce = !this.getSetting('backlight_enabled') && isOn;
          if (!willForce) this._applyBacklight(isOn);
        }
        if (attrs.powerOnStateGlobal != null)
          Object.assign(s, powerOnSettingsPatch(behaviorKey, currentKey, attrs.powerOnStateGlobal));
        return Object.keys(s).length ? this.setSettings(s) : null;
      })
      .catch(readAttrCatch(this, '[EP1] readAttributes onOff extended'));
  }


  // ── Indicator mode ──────────────────────────────────────────────────────────

  /**
   * Attach attr.indicatorMode listener — stores normalized enum string in settings.
   * @param {object} onOffCluster
   * @param {string} [settingKey='indicator_mode']
   */
  _attachIndicatorModeListener(onOffCluster, settingKey = 'indicator_mode', currentKey = null) {
    onOffCluster.on('attr.indicatorMode', value => {
      const observed = normalizeIndicatorMode(value);
      const desired  = this.getSetting(settingKey);

      // Master setting: the desired value is owned by the user (onSettings) and is
      // never overwritten here. Re-enforce it on the device only when the device
      // drifted from it — e.g. it reset to its default on power loss and
      // re-reported that on rejoin. If observed === desired the device already does
      // what the user wants, so do nothing (same rule as the backlight listener:
      // only act when it would otherwise be wrong). Debounced to avoid storms.
      if (desired && observed !== desired) {
        const now = Date.now();
        if (this._lastIndicatorEnforceTs && (now - this._lastIndicatorEnforceTs) < 20_000) return;
        this._lastIndicatorEnforceTs = now;
        this.log(`[EP1] indicatorMode: device=${observed}, user wants ${desired} — re-enforcing`);
        onOffCluster.setIndicatorMode(desired)
          .catch(err => this.error('Error re-enforcing indicatorMode:', err));
        return;
      }

      // In sync (or no desired stored yet): update only the observed label,
      // never the master setting (settingKey).
      this.log('[EP1] indicatorMode:', observed);
      if (currentKey) {
        this.setSettings({ [currentKey]: INDICATOR_LABELS[observed] ?? observed }).catch(() => {});
      }
    });
  }

  // ── Child lock ──────────────────────────────────────────────────────────────

  /**
   * Attach attr.childLock listener — stores boolean in settings.
   * @param {object} onOffCluster
   * @param {string} [settingKey='child_lock']
   */
  _attachChildLockListener(onOffCluster, settingKey = 'child_lock') {
    onOffCluster.on('attr.childLock', value => {
      this._trackBootBurst('childLock');
      this.log('[EP1] childLock:', value);
      this.setSettings({ [settingKey]: Boolean(value) }).catch(() => {});
    });
  }

  // ── onSettings helpers ──────────────────────────────────────────────────────

  /** Handle backlight_enabled setting change — write + re-sync checkbox. */
  async _onSettingBacklight(value) {
    await this.zclNode.endpoints[1].clusters.onOff
      .setBacklight(value)
      .catch(err => { this.error('Write backlightControl:', err); throw err; });
    setImmediate(() => this._applyBacklight(value));
  }

  /**
   * Handle switch_mode / switch_mode_global setting change.
   * @param {string} value      - 'toggle' or 'momentary'
   * @param {string} currentKey - label setting key (default: 'switch_mode_current')
   */
  async _onSettingSwitchMode(value, currentKey = 'switch_mode_current') {
    await this.zclNode.endpoints[1].clusters.tuyaPowerOnState
      .writeAttributes({ switchMode: value })
      .catch(err => this.error('Write switchMode:', err));
    setImmediate(() => this.setSettings({ [currentKey]: SWITCH_DISPLAY[value] || value }).catch(() => {}));
  }

  // ── Gang powerOnState helpers ───────────────────────────────────────────────

  /**
   * Attach attr.powerOnStateGang listener on a tuyaPowerOnState cluster.
   * If behaviorKey is null, only the display label (currentKey) is updated —
   * useful for cross-endpoint listeners on the main device.
   * @param {object} gangCluster
   * @param {number} epId
   * @param {string|null} behaviorKey  - enum setting key  (e.g. 'power_on_behavior_gang1')
   * @param {string}      currentKey   - label setting key (e.g. 'power_on_current_gang1')
   */
  _attachGangPowerOnListener(gangCluster, epId, behaviorKey, currentKey) {
    gangCluster.on('attr.powerOnStateGang', value => {
      this._trackBootBurst('powerOnGang');
      this.log(`[EP${epId}] powerOnStateGang:`, value);
      const patch = behaviorKey
        ? powerOnSettingsPatch(behaviorKey, currentKey, value)
        : { [currentKey]: getPowerOnLabel(value) };
      this.setSettings(patch)
        .catch(err => this.error(`setSettings powerOnStateGang EP${epId}:`, err));
    });
  }

  /**
   * Read powerOnStateGang once and persist to settings.
   * If behaviorKey is null, only the display label (currentKey) is written.
   * @param {object}      gangCluster
   * @param {number}      epId
   * @param {string|null} behaviorKey
   * @param {string}      currentKey
   */
  async _readGangPowerOnState(gangCluster, epId, behaviorKey, currentKey) {
    await gangCluster
      .readAttributes(['powerOnStateGang'])
      .then(attrs => {
        this.log(`[EP${epId}] read powerOnStateGang:`, attrs.powerOnStateGang);
        if (attrs.powerOnStateGang == null) return;
        const patch = behaviorKey
          ? powerOnSettingsPatch(behaviorKey, currentKey, attrs.powerOnStateGang)
          : { [currentKey]: getPowerOnLabel(attrs.powerOnStateGang) };
        return this.setSettings(patch);
      })
      .catch(readAttrCatch(this, `[EP${epId}] readAttributes tuyaPowerOnState`));
  }

  /**
   * Write powerOnStateGang to the device and sync the display-label setting.
   * @param {number} epId
   * @param {string} value       - enum value chosen in the UI
   * @param {string} currentKey  - label setting key to update after write
   */
  async _writeGangPowerOnState(epId, value, currentKey) {
    await this.zclNode.endpoints[epId].clusters.tuyaPowerOnState
      .writeAttributes({ powerOnStateGang: value })
      .catch(err => this.error(`Write powerOnStateGang EP${epId}:`, err));
    setImmediate(() =>
      this.setSettings({ [currentKey]: getPowerOnLabel(value) }).catch(() => {}));
  }

  // ── Reporting helper ────────────────────────────────────────────────────────

  /**
   * Configure onOff reporting on a list of endpoints. Best-effort — errors are
   * logged but not thrown so boot/rejoin continues even if the device is slow.
   * @param {object}   zclNode
   * @param {number[]} endpointIds
   */
  async _configureOnOffReporting(zclNode, endpointIds) {
    for (const epId of endpointIds) {
      await zclNode.endpoints[epId].clusters.onOff
        .configureReporting({ onOff: { minInterval: 0, maxInterval: applyJitter(ONOFF_REPORT_MAX_INTERVAL_S, 10), minChange: 0 } })
        .catch(err => this.error(`configureReporting onOff EP${epId}:`, err));
    }
  }

  // ── ZCL ON_OFF with retry ───────────────────────────────────────────────────

  async _onCapabilityOnOff(value) {
    const cluster = this.zclNode.endpoints[this._endpoint].clusters.onOff;
    this.log(`[${this._gangLabel}] command: ${value ? 'ON' : 'OFF'}`);
    let lastErr;
    for (let i = 0; i <= 2; i++) {
      try {
        if (value) await cluster.setOn();
        else await cluster.setOff();
        if (i > 0) this.log(`[${this._gangLabel}] retry succeeded on attempt ${i + 1}`);
        return;
      } catch (err) {
        lastErr = err;
        if (i < 2) {
          this.log(`[${this._gangLabel}] retry ${i + 1}/2...`);
          await new Promise(r => this.homey.setTimeout(r, 350));
        }
      }
    }
    this.error(`[${this._gangLabel}] command failed after 3 attempts:`, lastErr.message);
    // Mark device unavailable immediately — don't wait for the watchdog timeout.
    // Delegate to the main sibling's AvailabilityManager so all gangs + flow cards update.
    if (lastErr.message && lastErr.message.includes('Could not reach device')) {
      this._markAllUnreachable();
    }
  }

  /**
   * Mark all sibling gangs unavailable via the main device's AvailabilityManager
   * (so flow cards fire). Sub-devices don't have _availability, so we find the
   * main sibling. Falls back to direct setUnavailable if not found.
   */
  _markAllUnreachable() {
    try {
      const siblings = this._getNodeDevices();
      const main = siblings.find(d => d._availability);
      if (main) {
        main._availability.markUnavailable('Device unreachable').catch(() => {});
      } else {
        // Fallback: mark all directly (no flow trigger, but state is correct)
        siblings.forEach(s => s.setUnavailable('Device unreachable').catch(() => {}));
      }
    } catch (err) {
      this.setUnavailable('Device unreachable').catch(() => {});
    }
  }

  // ── Init helpers ────────────────────────────────────────────────────────────

  /** Install passive availability watchdog (EP1 only, main device). */
  async _installAvailability() {
    this._startedAt = Date.now();   // used by _notifyRejoin boot guard
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: HEARTBEAT_TIMEOUT_MS,
    });
    await this._availability.install();
  }

  /**
   * Boot-burst detector for power-restore rejoin. Independent of the availability
   * window, so it catches outages SHORTER than the offline timeout (e.g. a 10-min
   * cut when the offline window is 20 min) — that's the whole point of the
   * device_rejoined trigger vs. availability_turned_on.
   *
   * A real power cut reboots the device, which then re-reports its full config —
   * several DISTINCT config attributes within ~2s (inching*, powerOnState,
   * backlight, childLock) plus optionally a ZDO announce. We fire only when 3+
   * DISTINCT sources arrive in the window. This rejects:
   *   - a bare ZDO announce (routing rejoin, no power cut) → 1 source
   *   - periodic reporting / an active countdown (inchingTime + inchingRemain) →
   *     2 sources (onOff is deliberately NOT a source, so a countdown firing the
   *     relay does not add a third).
   * Only the main/single device aggregates; _notifyRejoin cascades to siblings.
   * @param {string} source - distinct signal name
   */
  _trackBootBurst(source) {
    if (this._isMainDevice === false) return;        // sub-devices skip; main aggregates
    const now = Date.now();
    this._bootBurst = (this._bootBurst ?? []).filter(e => now - e.t < 2000);
    this._bootBurst.push({ t: now, source });
    const sources = [...new Set(this._bootBurst.map(e => e.source))];
    // Logged at normal level (visible without debug) so the source mix behind a
    // rejoin is diagnosable — a real boot dump shows many distinct sources, a false
    // positive (e.g. periodic dump) shows which ones reached the threshold.
    this.log(`[rejoin] boot-burst sources(${sources.length}): ${sources.join(', ')}`);
    if (sources.length >= 3) {
      this._notifyRejoin();                          // own 120s guard + 30s cooldown dedup
    }
  }

  /**
   * Signal that this device rejoined the Zigbee network (called by _trackBootBurst
   * once a boot-dump burst is confirmed). Guards:
   *  - 120s post-startup: ignores the app-restart attribute dump
   *  - 30s cooldown: de-duplicates the burst of reports in the same rejoin event
   */
  _notifyRejoin() {
    const now = Date.now();
    if ((now - (this._startedAt ?? 0)) < 120_000) return;  // boot guard
    if ((now - (this._lastRejoinTs ?? 0)) < 30_000) return; // burst cooldown
    this._lastRejoinTs = now;
    this.onDeviceRejoin(0);  // gap duration unknown via this path
  }

  /**
   * Called by AvailabilityManager when a frame arrives after rejoinGapMs silence.
   * Fires the device_rejoined flow trigger card for this device.
   * @param {number} gapMs - Gap in milliseconds since last frame
   */
  onDeviceRejoin(gapMs) {
    this.log(`[${this._gangLabel}] Device rejoined (gap ${Math.round(gapMs / 1000)}s)`);
    const AvailabilityManager = require('./AvailabilityManager');
    // Card ID convention: {driverId}:device_rejoined — defined in driver.flow.compose.json.
    const cardId = this.driver?.id ? `${this.driver.id}:device_rejoined` : null;
    AvailabilityManager.triggerRejoin(this, gapMs, cardId);
  }

  /** Read basic cluster attributes (device info). */
  async _readBasicAttributes(zclNode) {
    await zclNode.endpoints[1].clusters.basic
      .readAttributes([
        'manufacturerName', 'zclVersion', 'appVersion',
        'modelId', 'powerSource', 'attributeReportingStatus',
      ])
      .catch(readAttrCatch(this, '[EP1] readAttributes basic'));
  }

  // ── Sibling name sync ───────────────────────────────────────────────────────

  onRenamed(name) {
    this.log(`Device renamed to: ${name}`);
    this._updateSiblingNames();
  }

  async _updateSiblingNames() {
    await updateSiblingNames(this);
  }

  // ── Availability lifecycle ──────────────────────────────────────────────────

  onEndDeviceAnnounce() {
    this.log(`[${this._gangLabel}] rejoined network (ZDO Device Announce)`);
    if (!this.getSetting('backlight_enabled')) {
      const onOff = this.zclNode?.endpoints?.[1]?.clusters?.onOff;
      if (onOff?.setBacklight) {
        this.log('[EP1] Rejoin: re-enforcing backlight OFF');
        onOff.setBacklight(false)
          .catch(err => this.log('Re-enforcing backlight off failed (rejoin):', err.message));
      }
    }
    // Fire device_rejoined flow only from main/single-gang device.
    // Sub-devices of multi-gang switches (this._isMainDevice === false) are skipped
    // because AvailabilityManager.triggerRejoin already cascades to all siblings.
    if (this._isMainDevice !== false) {
      this._trackBootBurst('announce');
    }
    // Restore availability immediately on ZDO announce — the device just joined the network.
    // Without this, a plug that lost Zigbee has its polling stopped; if the reporting config
    // was also lost on rejoin (common on Tuya TS011F), no ZCL frames arrive to trigger the
    // handleFrame hook, and the device stays stuck as unavailable until an app restart.
    if (!this.getAvailable()) {
      this._availability?.markAvailable().catch(() => {});
    }
  }

  // Runs when the device instance is destroyed without being removed
  // (app restart, update, node re-interview). onDeleted only fires on user
  // removal, so cleanup must also live here to avoid orphaned hooks/timers.
  async onUninit() {
    await this._teardown();
  }

  onDeleted() {
    this._teardown();
  }

  /** Idempotent cleanup — safe to call from both onUninit and onDeleted. */
  async _teardown() {
    await this._availability?.uninstall().catch(() => {});
  }

  async onBecameAvailable() {
    this.log(`[${this._gangLabel}] became available`);
    // Flow is already fired by AvailabilityManager._markAllAvailable for all siblings.

    // Re-enforce onOff reporting in case device lost config after rejoin / power cycle.
    const ep = this.zclNode?.endpoints?.[this._endpoint || 1];
    if (ep?.clusters?.onOff) {
      await ep.clusters.onOff
        .configureReporting({ onOff: { minInterval: 0, maxInterval: ONOFF_REPORT_MAX_INTERVAL_S, minChange: 0 } })
        .catch(err => this.log(`[${this._gangLabel}] onBecameAvailable: configureReporting failed:`, err.message));
    }
  }

  async onBecameUnavailable(reason) {
    this.log(`[${this._gangLabel}] became unavailable (${reason})`);
    // Flow is already fired by AvailabilityManager._markAllUnavailable for all siblings.
  }

}

module.exports = {
  TuyaZclBase,
  POWER_ON_DISPLAY,
  SWITCH_DISPLAY,
  SWITCH_NORMALIZE,
};
