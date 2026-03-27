'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { AvailabilityManagerCluster0 } = require('./AvailabilityManager');
const { readAttrCatch } = require('./errorUtils');
const { HEARTBEAT_TIMEOUT_MS, ONOFF_REPORT_MAX_INTERVAL_S } = require('./constants');

// ── Shared display constants ──────────────────────────────────────────────────
// powerOnStateGang  (tuyaPowerOnState) → device reports enum strings: 'off'/'on'/'lastState'
// powerOnStateGlobal (onOff extended)  → device reports uint8: 0/1/2
const POWER_ON_DISPLAY = { off: 'Always Off', on: 'Always On', lastState: 'Last State' };
const POWER_ON_MAP     = { 0: 'off',        1: 'on',        2: 'lastState' };
const POWER_ON_LABELS  = { 0: 'Always Off', 1: 'Always On', 2: 'Last State' };
const SWITCH_DISPLAY   = { toggle: 'Toggle (Standard)', momentary: 'Momentary (Pulse)' };
const SWITCH_NORMALIZE = v => (v === 'toggle' || v === 'momentary') ? v : 'toggle'; // firmware may report 'state' on first pair from another hub
const toRawPowerOn     = v => (typeof v === 'number' ? v : ({ off: 0, on: 1, lastState: 2 }[v] ?? 2));

// ─────────────────────────────────────────────────────────────────────────────

class NovaDigitalSwitchBase extends ZigBeeDevice {

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
      this.log('[EP1] backlightControl:', value);
      const isOn = (value === 'on' || value === 1 || value === true);
      if (isOn && !this.getSetting('backlight_enabled')) {
        this.log('[EP1] Device reported backlight ON but user wants OFF — re-enforcing');
        onOffCluster.setBacklight(false)
          .catch(err => this.error('Error re-enforcing backlight off:', err));
        return;
      }
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
      this.log('[EP1] powerOnStateGlobal:', value);
      const raw = toRawPowerOn(value);
      this.setSettings({
        [behaviorKey]: POWER_ON_MAP[raw]    ?? String(raw),
        [currentKey]:  POWER_ON_LABELS[raw] ?? String(raw),
      }).catch(err => this.error('setSettings powerOnStateGlobal:', err));

    });
  }

  /**
   * Read backlightControl + powerOnStateGlobal from EP1 and populate settings.
   * Skips _applyBacklight() if backlight will be re-enforced OFF immediately
   * (avoids a brief ON flash in the settings UI).
   *
   * @param {object} onOffCluster
   * @param {string} behaviorKey
   * @param {string} currentKey
   */
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
        if (attrs.powerOnStateGlobal != null) {
          const raw = toRawPowerOn(attrs.powerOnStateGlobal);
          s[behaviorKey] = POWER_ON_MAP[raw]    ?? String(raw);
          s[currentKey]  = POWER_ON_LABELS[raw] ?? String(raw);
        }
        return Object.keys(s).length ? this.setSettings(s) : null;
      })
      .catch(readAttrCatch(this, '[EP1] readAttributes onOff extended'));
  }


  // ── onSettings helpers ──────────────────────────────────────────────────────

  // ── Indicator mode ──────────────────────────────────────────────────────────

  /** Normalises raw uint8 (0/1/2) or string enum ('off'/'status'/'position'). */
  static _normalizeIndicatorMode(value) {
    const MAP = { 0: 'off', 1: 'status', 2: 'position' };
    return (typeof value === 'string') ? value : (MAP[value] ?? String(value));
  }

  /**
   * Attach attr.indicatorMode listener — stores normalized enum string in settings.
   * @param {object} onOffCluster
   * @param {string} [settingKey='indicator_mode']
   */
  _attachIndicatorModeListener(onOffCluster, settingKey = 'indicator_mode') {
    onOffCluster.on('attr.indicatorMode', value => {
      this.log('[EP1] indicatorMode:', value);
      const normalized = NovaDigitalSwitchBase._normalizeIndicatorMode(value);
      this.setSettings({ [settingKey]: normalized }).catch(() => {});
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
      const myIeee = this.getData().ieeeAddress;
      const siblings = this.driver.getDevices().filter(d => {
        try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
      });
      const main = siblings.find(d => d._availability);
      if (main) {
        main._availability._markAllUnavailable('Device unreachable').catch(() => {});
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
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: HEARTBEAT_TIMEOUT_MS,
    });
    await this._availability.install();
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
    try {
      const myIeee = this.getData().ieeeAddress;
      const siblings = this.driver.getDevices().filter(d => {
        try {
          return myIeee ? d.getData().ieeeAddress === myIeee : d.zclNode === this.zclNode;
        } catch { return false; }
      });

      if (!siblings.length) return;
      const infoText = siblings.map(d => {
        const isMain = !d.getData().subDeviceId;
        return isMain ? `${d.getName()} (Main)` : d.getName();
      }).join(' • ');
      await Promise.allSettled(
        siblings.map(d => d.setSettings({ device_siblings_info: infoText }).catch(() => {}))
      );
    } catch (err) {
      this.error('Error updating sibling names:', err.message);
    }
  }

  // ── Availability lifecycle ──────────────────────────────────────────────────

  onEndDeviceAnnounce() {
    this.log(`[${this._gangLabel}] rejoined network`);
    if (!this.getSetting('backlight_enabled')) {
      const onOff = this.zclNode?.endpoints?.[1]?.clusters?.onOff;
      if (onOff?.setBacklight) {
        this.log('[EP1] Rejoin: re-enforcing backlight OFF');
        onOff.setBacklight(false)
          .catch(err => this.log('Re-enforcing backlight off failed (rejoin):', err.message));
      }
    }
  }

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
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

const INDICATOR_MAP = { 0: 'off', 1: 'status', 2: 'position' };

module.exports = {
  NovaDigitalSwitchBase,
  POWER_ON_DISPLAY,
  POWER_ON_MAP,
  POWER_ON_LABELS,
  SWITCH_DISPLAY,
  SWITCH_NORMALIZE,
  INDICATOR_MAP,
  toRawPowerOn,
};
