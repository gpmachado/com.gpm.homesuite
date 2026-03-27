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

class novadigital_switch_1gang extends NovaDigitalSwitchBase {

  async onNodeInit({ zclNode }) {

    this.printNode();
    try { if (zclNode.endpoints[1]?.clusters?.basic) zclNode.endpoints[1].bind('basic', new BasicSilentBoundCluster()); } catch {}

    this._endpoint  = 1;
    this._gangLabel = 'Gang 1';

    const firstInit = this.isFirstInit();
    this.log(`[${this._gangLabel}] init -- ${this.getName()} ep:1 firstInit:${firstInit}`);

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
    const onOffCluster = zclNode.endpoints[1].clusters.onOff;

    onOffCluster.on('attr.onOff', value => {
      this.log(`[${this._gangLabel}] attr.onOff: ${value}`);
      this.setCapabilityValue('onoff', value)
        .catch(err => this.error(`[${this._gangLabel}] setCapabilityValue onoff:`, err));
    });

    try {
      zclNode.endpoints[1].bind('onOff', new OnOffBoundCluster({
        onSetOn:  () => { this.log(`[${this._gangLabel}] bound setOn`);  this.setCapabilityValue('onoff', true).catch(() => {}); },
        onSetOff: () => { this.log(`[${this._gangLabel}] bound setOff`); this.setCapabilityValue('onoff', false).catch(() => {}); },
        onToggle: () => { this.log(`[${this._gangLabel}] bound toggle`); this.setCapabilityValue('onoff', !this.getCapabilityValue('onoff')).catch(() => {}); },
      }));
    } catch (err) {
      this.log(`[${this._gangLabel}] OnOffBoundCluster bind failed:`, err.message);
    }

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));
    this.setCapabilityValue('main_gang', true).catch(() => {});

    // -- tuyaPowerOnState listeners (EP1) ------------------------------------
    const gangCluster = zclNode.endpoints[1].clusters.tuyaPowerOnState;

    gangCluster.on('attr.powerOnStateGang', value => {
      this.log('[EP1] powerOnStateGang:', value);
      this.setSettings({
        power_on_behavior_gang1: value,
        power_on_current_gang1:  POWER_ON_DISPLAY[value] || value,
      }).catch(err => this.error('setSettings powerOnStateGang:', err));
    });

    gangCluster.on('attr.switchMode', value => {
      this.log('[EP1] switchMode:', value);
      const norm = SWITCH_NORMALIZE(value);
      this.setSettings({
        switch_mode_global:  norm,
        switch_mode_current: SWITCH_DISPLAY[norm] || norm,
      }).catch(err => this.error('setSettings switchMode:', err));
    });

    // -- Extended onOff listeners (backlight + powerOnStateGlobal) -----------
    this._attachBacklightListener(onOffCluster);
    this._attachPowerOnGlobalListener(onOffCluster, 'power_on_behavior_global', 'power_on_current_global');
    onOffCluster
      .on('attr.indicatorMode', value => this.log('[EP1] indicatorMode:', value))
      .on('attr.childLock',     value => this.log('[EP1] childLock:', value));

    // -- Availability --------------------------------------------------------
    await this._installAvailability();

    // -- Read basic cluster attributes ---------------------------------------
    await this._readBasicAttributes(zclNode);

    // -- Read extended onOff attrs ------------------------------------------
    await this._readExtendedOnOffAttrs(onOffCluster, 'power_on_behavior_global', 'power_on_current_global');

    // -- Read tuyaPowerOnState (gang + switchMode) — first pairing only ------
    // Device stores these in non-volatile memory; no need to re-read every boot.
    if (firstInit || !this.getSetting('power_on_behavior_gang1')) {
      await gangCluster
        .readAttributes(['powerOnStateGang', 'switchMode'])
        .then(attrs => {
          this.log('[EP1] read tuyaPowerOnState:', attrs);
          const s = {};
          if (attrs.powerOnStateGang != null) {
            s.power_on_behavior_gang1 = attrs.powerOnStateGang;
            s.power_on_current_gang1  = POWER_ON_DISPLAY[attrs.powerOnStateGang] || attrs.powerOnStateGang;
          }
          if (attrs.switchMode != null) {
            const norm            = SWITCH_NORMALIZE(attrs.switchMode);
            s.switch_mode_global  = norm;
            s.switch_mode_current = SWITCH_DISPLAY[norm] || norm;
          }
          return Object.keys(s).length ? this.setSettings(s) : null;
        })
        .catch(readAttrCatch(this, '[EP1] readAttributes tuyaPowerOnState'));
    }

    // -- First pairing: configure reporting ----------------------------------
    if (firstInit) {
      this.log('First init -- configuring onOff reporting');
      await zclNode.endpoints[1].clusters.onOff
        .configureReporting({ onOff: { minInterval: 0, maxInterval: ONOFF_REPORT_MAX_INTERVAL_S, minChange: 0 } })
        .catch(err => this.error('configureReporting onOff EP1:', err));
    }
  }

  // ---------------------------------------------------------------------------
  // Settings write
  // ---------------------------------------------------------------------------

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    for (const key of changedKeys.filter(k => !k.endsWith('_current'))) {
      const value = newSettings[key];

      switch (key) {

        case 'backlight_enabled':
          await this._onSettingBacklight(value);
          break;

        case 'power_on_behavior_global':
          await this.zclNode.endpoints[1].clusters.onOff
            .setGlobalPowerOnState(value)
            .catch(err => this.error('Write powerOnStateGlobal:', err));
          setImmediate(() => this.setSettings({ power_on_current_global: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
          break;

        case 'switch_mode_global':
          await this._onSettingSwitchMode(value, 'switch_mode_current');
          break;

        case 'power_on_behavior_gang1':
          await this.zclNode.endpoints[1].clusters.tuyaPowerOnState
            .writeAttributes({ powerOnStateGang: value })
            .catch(err => this.error('Write powerOnStateGang EP1:', err));
          setImmediate(() => this.setSettings({ power_on_current_gang1: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
          break;

        default:
          this.log(`Unknown setting key: ${key}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onDeleted() {
    super.onDeleted();
    this.log('NovaDigital Switch 1 Gang removed');
  }

}

module.exports = novadigital_switch_1gang;
