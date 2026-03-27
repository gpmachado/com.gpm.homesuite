'use strict';

const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const { readAttrCatch } = require('../../lib/errorUtils');
const { ONOFF_REPORT_MAX_INTERVAL_S } = require('../../lib/constants');
const { BasicSilentBoundCluster } = require('../../lib/TimeCluster');
const {
  NovaDigitalSwitchBase,
  POWER_ON_DISPLAY,
  SWITCH_DISPLAY,
  SWITCH_NORMALIZE,
} = require('../../lib/NovaDigitalSwitchBase');

class novadigital_switch_2gang extends NovaDigitalSwitchBase {

  async onNodeInit({ zclNode }) {

    this.printNode();
    try { if (zclNode.endpoints[1]?.clusters?.basic) zclNode.endpoints[1].bind('basic', new BasicSilentBoundCluster()); } catch {}

    const { subDeviceId } = this.getData();
    if (subDeviceId === 'secondSwitch') {
      this._endpoint  = 2;
      this._gangLabel = 'Gang 2';
    } else {
      this._endpoint  = 1;
      this._gangLabel = 'Main (Gang 1)';
    }
    this._isMainDevice = !subDeviceId;

    const firstInit = this.isFirstInit();
    this.log(`[${this._gangLabel}] init -- ${this.getName()} ep:${this._endpoint} firstInit:${firstInit}`);

    // -- OnOff capability ----------------------------------------------------
    // registerCapability intentionally omitted: it registers an internal listener
    // that conflicts with registerCapabilityListener ("already registered" warning).
    //
    // Physical button → Homey:
    //   attr.onOff   — handles ZCL attribute reports (cmdId=10, most common)
    //   OnOffBoundCluster — handles ZCL commands (setOn/setOff/toggle via binding)
    //
    // Homey UI → device:
    //   registerCapabilityListener — calls _onCapabilityOnOff (with retry logic)
    const onOffCluster = zclNode.endpoints[this._endpoint].clusters.onOff;

    onOffCluster.on('attr.onOff', value => {
      this.log(`[${this._gangLabel}] attr.onOff: ${value}`);
      this.setCapabilityValue('onoff', value)
        .catch(err => this.error(`[${this._gangLabel}] setCapabilityValue onoff:`, err));
    });

    try {
      zclNode.endpoints[this._endpoint].bind('onOff', new OnOffBoundCluster({
        onSetOn:  () => { this.log(`[${this._gangLabel}] bound setOn`);  this.setCapabilityValue('onoff', true).catch(() => {}); },
        onSetOff: () => { this.log(`[${this._gangLabel}] bound setOff`); this.setCapabilityValue('onoff', false).catch(() => {}); },
        onToggle: () => { this.log(`[${this._gangLabel}] bound toggle`); this.setCapabilityValue('onoff', !this.getCapabilityValue('onoff')).catch(() => {}); },
      }));
    } catch (err) {
      this.log(`[${this._gangLabel}] OnOffBoundCluster bind failed:`, err.message);
    }

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    // -- Per-gang: tuyaPowerOnState listeners --------------------------------
    const gangCluster = zclNode.endpoints[this._endpoint].clusters.tuyaPowerOnState;

    if (this._isMainDevice) {
      gangCluster.on('attr.powerOnStateGang', value => {
        this.log(`[EP${this._endpoint}] powerOnStateGang:`, value);
        this.setSettings({
          power_on_behavior_gang1: value,
          power_on_current_gang1:  POWER_ON_DISPLAY[value] || value,
        }).catch(err => this.error('setSettings powerOnStateGang EP1:', err));
      });

      gangCluster.on('attr.switchMode', value => {
        this.log(`[EP${this._endpoint}] switchMode:`, value);
        const norm  = SWITCH_NORMALIZE(value);
        const label = SWITCH_DISPLAY[norm] || norm;
        this.setSettings({
          switch_mode_global:  norm,
          switch_mode_current: label,
        }).catch(err => this.error('setSettings switchMode:', err));
        this._propagateSwitchModeLabel(label);
      });
    } else {
      gangCluster.on('attr.powerOnStateGang', value => {
        this.log(`[EP${this._endpoint}] powerOnStateGang:`, value);
        this.setSettings({
          power_on_behavior_gang2: value,
          power_on_current_gang2:  POWER_ON_DISPLAY[value] || value,
        }).catch(err => this.error('setSettings powerOnStateGang EP2:', err));
      });
    }

    // Read gang power-on state — first pairing only (stored in non-volatile memory).
    // On rejoin the device reports it via attr.powerOnStateGang listener automatically.
    const gangSettingKey = this._isMainDevice ? 'power_on_behavior_gang1' : 'power_on_behavior_gang2';
    if (firstInit || !this.getSetting(gangSettingKey)) {
      gangCluster.readAttributes(['powerOnStateGang'])
        .then(attrs => {
          this.log(`[EP${this._endpoint}] read powerOnStateGang:`, attrs.powerOnStateGang);
          if (attrs.powerOnStateGang != null) {
            const v     = attrs.powerOnStateGang;
            const patch = this._isMainDevice
              ? { power_on_behavior_gang1: v, power_on_current_gang1: POWER_ON_DISPLAY[v] || v }
              : { power_on_behavior_gang2: v, power_on_current_gang2: POWER_ON_DISPLAY[v] || v };
            return this.setSettings(patch);
          }
        })
        .catch(readAttrCatch(this, `[EP${this._endpoint}] readAttributes tuyaPowerOnState`));
    }

    // -- Main device only (EP1) ----------------------------------------------
    if (this._isMainDevice) {

      this.setCapabilityValue('main_gang', true).catch(() => {});

      const onOffCluster = zclNode.endpoints[1].clusters.onOff;

      // Extended onOff listeners (backlight + powerOnStateGlobal)
      this._attachBacklightListener(onOffCluster);
      this._attachPowerOnGlobalListener(onOffCluster, 'power_on_behavior_global', 'power_on_current_global');
      onOffCluster
        .on('attr.indicatorMode', value => this.log('[EP1] indicatorMode:', value))
        .on('attr.childLock',     value => this.log('[EP1] childLock:', value));

      // Cross-endpoint: keep main device's gang2 current label in sync
      zclNode.endpoints[2].clusters.tuyaPowerOnState
        .on('attr.powerOnStateGang', value => {
          this.log('[EP2] powerOnStateGang (main listener):', value);
          this.setSettings({ power_on_current_gang2: POWER_ON_DISPLAY[value] || value })
            .catch(err => this.error('setSettings gang2 current:', err));
        });

      // Inching attrs (tuyaE000 — not implemented; suppress noisy log entries)
      zclNode.endpoints[1].clusters.tuyaE000
        .on('attr.inchingTime',   () => {})
        .on('attr.inchingRemain', () => {});

      // -- Availability --------------------------------------------------------
      await this._installAvailability();

      // -- Read basic cluster attributes --------------------------------------
      await this._readBasicAttributes(zclNode);

      // Fetch and display initial sibling names
      await this._updateSiblingNames();

      // -- Read extended onOff attrs ------------------------------------------
      await this._readExtendedOnOffAttrs(onOffCluster, 'power_on_behavior_global', 'power_on_current_global');

      // -- Read switchMode + gang power-on — first pairing only --------------
      // Device stores these in non-volatile memory; no need to re-read every boot.
      if (firstInit || !this.getSetting('switch_mode_global')) {
        await zclNode.endpoints[1].clusters.tuyaPowerOnState
          .readAttributes(['switchMode'])
          .then(attrs => {
            this.log('[EP1] read switchMode:', attrs.switchMode);
            if (attrs.switchMode != null) {
              const norm  = SWITCH_NORMALIZE(attrs.switchMode);
              const label = SWITCH_DISPLAY[norm] || norm;
              this.setSettings({
                switch_mode_global:  norm,
                switch_mode_current: label,
              }).catch(err => this.error('setSettings switchMode init:', err));
              this._propagateSwitchModeLabel(label);
            }
          })
          .catch(readAttrCatch(this, '[EP1] readAttributes switchMode'));

        await zclNode.endpoints[2].clusters.tuyaPowerOnState
          .readAttributes(['powerOnStateGang'])
          .then(attrs => {
            this.log('[EP2] read powerOnStateGang:', attrs.powerOnStateGang);
            if (attrs.powerOnStateGang != null) {
              return this.setSettings({
                power_on_current_gang2: POWER_ON_DISPLAY[attrs.powerOnStateGang] || attrs.powerOnStateGang,
              });
            }
          })
          .catch(readAttrCatch(this, '[EP2] readAttributes tuyaPowerOnState'));
      }

      // -- First pairing: configure reporting --------------------------------
      if (firstInit) {
        this.log('First init -- configuring onOff reporting on all endpoints');
        for (const epId of [1, 2]) {
          await zclNode.endpoints[epId].clusters.onOff
            .configureReporting({ onOff: { minInterval: 0, maxInterval: ONOFF_REPORT_MAX_INTERVAL_S, minChange: 0 } })
            .catch(err => this.error(`configureReporting onOff EP${epId}:`, err));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Settings write
  // ---------------------------------------------------------------------------

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    for (const key of changedKeys.filter(k => !k.endsWith('_current') && k !== 'switch_mode_readonly')) {
      const value = newSettings[key];

      switch (key) {

        case 'backlight_enabled':
          await this._onSettingBacklight(value);
          break;

        case 'power_on_behavior_global': {
          const label    = POWER_ON_DISPLAY[value] || value;
          const siblings = this.driver.getDevices().filter(d => d !== this && !d._isMainDevice);
          await this.zclNode.endpoints[1].clusters.onOff
            .setGlobalPowerOnState(value)
            .catch(err => this.error('Write powerOnStateGlobal:', err));
          setImmediate(() => {
            this.setSettings({
              power_on_current_global: label,
              power_on_current_gang1:  label,
              power_on_current_gang2:  label,
            }).catch(() => {});
            siblings.forEach(sib => sib.setSettings({
              power_on_behavior_gang2: value,
              power_on_current_gang2:  label,
            }).catch(() => {}));
          });
          break;
        }

        case 'switch_mode_global': {
          const label = SWITCH_DISPLAY[value] || value;
          await this.zclNode.endpoints[1].clusters.tuyaPowerOnState
            .writeAttributes({ switchMode: value })
            .catch(err => this.error('Write switchMode:', err));
          setImmediate(() => {
            this._propagateSwitchModeLabel(label);
            this.setSettings({ switch_mode_current: label }).catch(() => {});
          });
          break;
        }

        case 'power_on_behavior_gang1':
          await this.zclNode.endpoints[1].clusters.tuyaPowerOnState
            .writeAttributes({ powerOnStateGang: value })
            .catch(err => this.error('Write powerOnStateGang EP1:', err));
          setImmediate(() => this.setSettings({ power_on_current_gang1: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
          break;

        case 'power_on_behavior_gang2':
          await this.zclNode.endpoints[2].clusters.tuyaPowerOnState
            .writeAttributes({ powerOnStateGang: value })
            .catch(err => this.error('Write powerOnStateGang EP2:', err));
          setImmediate(() => this.setSettings({ power_on_current_gang2: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
          break;

        default:
          this.log(`Unknown setting key: ${key}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Switch mode propagation to secondary device tile
  // ---------------------------------------------------------------------------

  _propagateSwitchModeLabel(label) {
    const siblings = this.driver.getDevices().filter(d => d !== this && !d._isMainDevice);
    for (const sibling of siblings) {
      sibling.setSettings({ switch_mode_readonly: label }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onDeleted() {
    super.onDeleted();
    this.log(`NovaDigital Switch 2 Gang, ${this._gangLabel} removed`);
  }

}

module.exports = novadigital_switch_2gang;
