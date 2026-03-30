'use strict';

/**
 * @file device.js
 * @description Power Strip 4 Sockets + USB (TS011F / _TZ3000_cfnprab5)
 *
 * Extends NovaDigitalSwitchBase — reuses:
 *   _onCapabilityOnOff      retry + _markAllUnreachable
 *   _attachBacklightListener          (NovaDigitalSwitchBase)
 *   _attachPowerOnGlobalListener      (NovaDigitalSwitchBase)
 *   _readExtendedOnOffAttrs           (NovaDigitalSwitchBase)
 *   _bootPersistBacklight             (NovaDigitalSwitchBase)
 *   _onSettingBacklight               (NovaDigitalSwitchBase)
 *   onRenamed / onDeleted / onBecameUnavailable  (NovaDigitalSwitchBase)
 *
 * Overrides:
 *   _installAvailability  → SOCKET_POWER_STRIP_TIMEOUT_MS
 *   _updateSiblingNames   → SOCKET_ORDER + writeSiblingNames
 *   onBecameAvailable     → re-sync onOff state on rejoin
 *   onDeleted             → clear handleFrame override
 *
 * ExtendedOnOffCluster (backlightControl, powerOnStateGlobal, childLock) is
 * registered globally by clusterRegistry.js — no monkey-patching needed.
 */

const { CLUSTER } = require('zigbee-clusters');
const {
  NovaDigitalSwitchBase,
  POWER_ON_DISPLAY,
} = require('../../lib/NovaDigitalSwitchBase');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { writeSiblingNames } = require('../../lib/connectedDevices');
const { SOCKET_POWER_STRIP_TIMEOUT_MS, ONOFF_REPORT_MAX_INTERVAL_S } = require('../../lib/constants');

/** subDeviceId → Zigbee endpoint number */
const ENDPOINT_MAP = Object.freeze({ socket2: 2, socket3: 3, socket4: 4, usb: 5 });

/** Sort order for sibling label sync */
const SOCKET_ORDER  = Object.freeze({ '': 0, socket2: 1, socket3: 2, socket4: 3, usb: 4 });

class PowerStripDevice extends NovaDigitalSwitchBase {

  async onNodeInit({ zclNode }) {
    this.printNode();

    const { subDeviceId } = this.getData();
    this._endpoint     = ENDPOINT_MAP[subDeviceId] || 1;
    this._gangLabel    = subDeviceId || 'socket1';
    this._isMainDevice = !subDeviceId;

    this.log(`[Init] ${this._gangLabel} (ep${this._endpoint})`);

    // ── On/Off ──────────────────────────────────────────────────────────────
    // registerCapability intentionally omitted: it causes double "handle report"
    // entries. Attribute reports still reach the capability via configureAttributeReporting
    // below. registerCapabilityListener alone is sufficient for UI → device commands.
    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    // ── Main device only (EP1) ───────────────────────────────────────────────
    if (this._isMainDevice) {

      // Silence Time cluster requests from TS011F
      const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');
      for (const ep of [1, 2, 3, 4, 5]) {
        try {
          if (zclNode.endpoints[ep]?.clusters?.time) {
            zclNode.endpoints[ep].bind('time', new TimeSilentBoundCluster());
          }
        } catch {}
      }

      // Silence unknown-command noise from secondary on/off endpoints
      // (allow attribute reports cmdId=10 so Homey UI stays in sync)
      const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
      const silent = new OnOffBoundCluster();
      const origFrame = zclNode.handleFrame;
      zclNode.handleFrame = (ep, cl, frame, meta) => {
        if (ep > 1 && ep <= 5 && cl === 6 && frame?.cmdId && frame.cmdId !== 10) return true;
        return typeof origFrame === 'function' ? origFrame(ep, cl, frame, meta) : false;
      };
      for (const ep of [1, 2, 3, 4, 5]) {
        try { if (zclNode.endpoints[ep]) zclNode.endpoints[ep].bind(CLUSTER.ON_OFF.NAME, silent); } catch {}
      }

      // Reduce heartbeat traffic — deferred 30 s to let mesh stabilise after restart
      this.homey.setTimeout(() => {
        if (!this.zclNode) return;
        this.configureAttributeReporting(
          [1, 2, 3, 4, 5].map(ep => ({
            endpointId: ep, cluster: CLUSTER.ON_OFF,
            attributeName: 'onOff', minInterval: 0, maxInterval: ONOFF_REPORT_MAX_INTERVAL_S, minChange: 0,
          }))
        ).catch(err => this.log('[Reporting] deferred config failed:', err.message));
      }, 30 * 1000);

      // ── Settings listeners ───────────────────────────────────────────────
      // ExtendedOnOffCluster is already registered globally (clusterRegistry.js),
      // so clusters.onOff is an instance of ExtendedOnOffCluster with all vendor attrs.
      // NOTE: TS011F does NOT support backlightControl (0x5000) — omitted.
      const onOffCluster = zclNode.endpoints[1].clusters.onOff;

      // powerOnStateGlobal — inline listener (base class version also re-enforces
      // backlight which is not applicable to this device)
      onOffCluster.on('attr.powerOnStateGlobal', value => {
        this.log('[EP1] powerOnStateGlobal:', value);
        this.setSettings({
          power_on_behavior_global: value,
          power_on_current_global:  POWER_ON_DISPLAY[value] || String(value),
        }).catch(err => this.error('setSettings powerOnStateGlobal:', err));
      });

      onOffCluster.on('attr.indicatorMode', value => {
        this.log('[EP1] indicatorMode:', value);
        this.setSettings({ indicator_mode: NovaDigitalSwitchBase._normalizeIndicatorMode(value) }).catch(() => {});
      });

      onOffCluster.on('attr.childLock', value => {
        this.log('[EP1] childLock:', value);
        this.setSettings({ child_lock: Boolean(value) }).catch(() => {});
      });

      // Read initial powerOnStateGlobal + indicatorMode — first pairing only.
      // Non-volatile settings; no need to re-read on every boot.
      if (this.isFirstInit() || !this.getSetting('power_on_behavior_global'))
      await onOffCluster.readAttributes(['powerOnStateGlobal', 'indicatorMode'])
        .then(attrs => {
          this.log('[EP1] read onOff extended:', attrs);
          const update = {};
          if (attrs.powerOnStateGlobal != null) {
            const val = attrs.powerOnStateGlobal;
            update.power_on_behavior_global = val;
            update.power_on_current_global  = POWER_ON_DISPLAY[val] || String(val);
          }
          if (attrs.indicatorMode != null) {
            update.indicator_mode = NovaDigitalSwitchBase._normalizeIndicatorMode(attrs.indicatorMode);
          }
          return Object.keys(update).length ? this.setSettings(update) : null;
        })
        .catch(err => this.log('[EP1] read onOff extended failed:', err.message));

      // ── Availability watchdog ────────────────────────────────────────────
      await this._installAvailability();
    }

    // ── Sibling labels ─────────────────────────────────────────────────────
    // Called by every sub-device so siblings that initialise after the main
    // device are still included in each other's "Connected Sockets" label.
    await this._updateSiblingNames();

    await this.ready();
    this.log(`[Init] ${this._gangLabel} ready`);
  }

  // ── Settings write ─────────────────────────────────────────────────────────

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    for (const key of changedKeys) {
      const value = newSettings[key];
      switch (key) {

        case 'power_on_behavior_global':
          // value is 'off' / 'on' / 'lastState' (enum string)
          await this.zclNode.endpoints[1].clusters.onOff
            .setGlobalPowerOnState(value)
            .catch(err => { this.error('Write powerOnStateGlobal:', err); throw err; });
          setImmediate(() =>
            this.setSettings({ power_on_current_global: POWER_ON_DISPLAY[value] || value })
              .catch(() => {})
          );
          break;

        case 'indicator_mode':
          await this.zclNode.endpoints[1].clusters.onOff
            .setIndicatorMode(value)
            .catch(err => { this.error('Write indicatorMode:', err); throw err; });
          break;

        case 'child_lock':
          await this.zclNode.endpoints[1].clusters.onOff
            .setChildLock(value)
            .catch(err => { this.error('Write childLock:', err); throw err; });
          break;

        default:
          this.log('Unknown setting key:', key);
      }
    }
  }

  // ── Rejoin state sync ──────────────────────────────────────────────────────

  /**
   * Re-reads onOff state from all endpoints after device rejoins the network.
   * Keeps Homey capability values in sync without waiting for the next attribute report.
   */
  async onBecameAvailable() {
    this.log(`[${this._gangLabel}] became available`);
    if (!this._isMainDevice) return;
    try {
      const myIeee = this.getData()?.ieeeAddress;
      const siblings = this.driver.getDevices().filter(d => {
        try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
      });
      for (const device of siblings) {
        const ep = ENDPOINT_MAP[device.getData().subDeviceId] || 1;
        const attrs = await this.zclNode.endpoints[ep].clusters.onOff
          .readAttributes(['onOff'])
          .catch(() => ({}));
        if (attrs.onOff !== undefined) {
          await device.setCapabilityValue('onoff', attrs.onOff).catch(() => {});
          this.log(`[Rejoin] ep${ep} onOff=${attrs.onOff}`);
        }
      }
    } catch (err) {
      this.log('[Rejoin] state sync failed:', err.message);
    }

    // Re-enforce attribute reporting in case device lost config after power cycle / rejoin
    await this.configureAttributeReporting(
      [1, 2, 3, 4, 5].map(ep => ({
        endpointId: ep, cluster: CLUSTER.ON_OFF,
        attributeName: 'onOff', minInterval: 0, maxInterval: ONOFF_REPORT_MAX_INTERVAL_S, minChange: 0,
      }))
    ).catch(err => this.log('[Reporting] rejoin re-enforce failed:', err.message));
  }

  // ── Overrides ──────────────────────────────────────────────────────────────

  async _installAvailability() {
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: SOCKET_POWER_STRIP_TIMEOUT_MS,
    });
    await this._availability.install();
  }

  async _updateSiblingNames() {
    try {
      const myIeee = this.getData()?.ieeeAddress;
      const siblings = this.driver.getDevices()
        .filter(d => {
          try {
            return myIeee ? d.getData().ieeeAddress === myIeee : d.zclNode === this.zclNode;
          } catch { return false; }
        })
        .sort((a, b) =>
          (SOCKET_ORDER[a.getData().subDeviceId ?? ''] ?? 99) -
          (SOCKET_ORDER[b.getData().subDeviceId ?? ''] ?? 99)
        );
      await writeSiblingNames(siblings);
    } catch (err) {
      this.error('Error updating sibling names:', err.message);
    }
  }

  onDeleted() {
    if (this.zclNode) this.zclNode.handleFrame = null;
    super.onDeleted();
    this.log('Power Strip removed');
  }
}

module.exports = PowerStripDevice;
