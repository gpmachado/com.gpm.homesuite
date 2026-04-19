'use strict';

const { TimeSilentBoundCluster, BasicSilentBoundCluster } = require('../../lib/TimeCluster');
const { readAttrCatch } = require('../../lib/errorUtils');
const { ONOFF_REPORT_MAX_INTERVAL_S } = require('../../lib/constants');
const {
  NovaDigitalSwitchBase,
  POWER_ON_DISPLAY,
  SWITCH_DISPLAY,
  SWITCH_NORMALIZE,
} = require('../../lib/NovaDigitalSwitchBase');

class novadigital_switch_3gang extends NovaDigitalSwitchBase {

  async onNodeInit({ zclNode }) {

    this.printNode();

    // -- Gang identity -------------------------------------------------------
    const { subDeviceId } = this.getData();
    if (subDeviceId === 'secondSwitch') {
      this._endpoint  = 2;
      this._gangLabel = 'Gang 2';
    } else if (subDeviceId === 'thirdSwitch') {
      this._endpoint  = 3;
      this._gangLabel = 'Gang 3';
    } else {
      this._endpoint  = 1;
      this._gangLabel = 'Main (Gang 1)';
    }
    this._isMainDevice = !subDeviceId;

    const firstInit = this.isFirstInit();
    this.log(`[${this._gangLabel}] init -- ${this.getName()} ep:${this._endpoint} firstInit:${firstInit}`);

    // -- OnOff capability ----------------------------------------------------
    this._setupOnOffEndpoint(zclNode);

    // -- Per-gang: tuyaPowerOnState listeners --------------------------------
    const gangCluster = zclNode.endpoints[this._endpoint].clusters.tuyaPowerOnState;

    gangCluster.on('attr.powerOnStateGang', value => {
      this.log(`[EP${this._endpoint}] powerOnStateGang:`, value);
      this.setSettings({
        [`power_on_gang${this._endpoint}`]:         value,
        [`power_on_gang${this._endpoint}_current`]: POWER_ON_DISPLAY[value] || value,
      }).catch(err => this.error('setSettings powerOnStateGang:', err));
    });

    if (this._isMainDevice) {
      gangCluster.on('attr.switchMode', value => {
        this.log(`[EP${this._endpoint}] switchMode:`, value);
        const norm = SWITCH_NORMALIZE(value);
        this.setSettings({
          switch_mode:         norm,
          switch_mode_current: SWITCH_DISPLAY[norm] || norm,
        }).catch(err => this.error('setSettings switchMode:', err));
      });
    }

    // Read gang power-on state — first pairing only (stored in non-volatile memory).
    // On rejoin the device reports it via attr.powerOnStateGang listener automatically.
    if (firstInit || !this.getSetting(`power_on_gang${this._endpoint}`)) {
      gangCluster.readAttributes(['powerOnStateGang'])
        .then(attrs => {
          this.log(`[EP${this._endpoint}] read powerOnStateGang:`, attrs.powerOnStateGang);
          if (attrs.powerOnStateGang != null) {
            const v = attrs.powerOnStateGang;
            return this.setSettings({
              [`power_on_gang${this._endpoint}`]:         v,
              [`power_on_gang${this._endpoint}_current`]: POWER_ON_DISPLAY[v] || v,
            });
          }
        })
        .catch(readAttrCatch(this, `[EP${this._endpoint}] readAttributes tuyaPowerOnState`));
    }

    // -- Main device only (EP1) ----------------------------------------------
    if (this._isMainDevice) {

      if (this.hasCapability('main_gang')) {
        this.setCapabilityValue('main_gang', true).catch(() => {});
      }

      const onOffCluster = zclNode.endpoints[1].clusters.onOff;

      // Extended onOff listeners (backlight + powerOnStateGlobal + indicator + childLock)
      this._attachBacklightListener(onOffCluster);
      this._attachPowerOnGlobalListener(onOffCluster, 'power_on_global', 'power_on_global_current');
      this._attachIndicatorModeListener(onOffCluster);
      // childLock: TS0003 reports it but it's not user-configurable on a wall switch
      onOffCluster.on('attr.childLock', value => this.log('[EP1] childLock:', value));

      // Cross-endpoint: keep main device's gang2/gang3 current labels in sync
      for (const epId of [2, 3]) {
        zclNode.endpoints[epId].clusters.tuyaPowerOnState
          .on('attr.powerOnStateGang', value => {
            this.log(`[EP${epId}] powerOnStateGang (main listener):`, value);
            this.setSettings({
              [`power_on_gang${epId}`]:         value,
              [`power_on_gang${epId}_current`]: POWER_ON_DISPLAY[value] || value,
            }).catch(err => this.error(`setSettings gang${epId} current:`, err));
          });
      }

      this._suppressTuyaE000(zclNode);

      // Suppress Time + Basic cluster frame spam
      try {
        const ep1 = zclNode.endpoints[1];
        if (ep1.clusters.time)  ep1.bind('time',  new TimeSilentBoundCluster());
        if (ep1.clusters.basic) ep1.bind('basic', new BasicSilentBoundCluster());
      } catch (err) {}

      // -- Availability --------------------------------------------------------
      await this._installAvailability();

      // -- Read basic cluster attributes --------------------------------------
      await this._readBasicAttributes(zclNode);

      // Fetch and display initial sibling names
      await this._updateSiblingNames();

      // -- Read extended onOff attrs ------------------------------------------
      await this._readExtendedOnOffAttrs(onOffCluster, 'power_on_global', 'power_on_global_current');

      // -- Read switchMode + EP2/EP3 gang power-on — first pairing only ------
      // Device stores these in non-volatile memory; no need to re-read every boot.
      // On rejoin the device will report these via attribute listeners automatically.
      if (firstInit || !this.getSetting('switch_mode')) {
        await zclNode.endpoints[1].clusters.tuyaPowerOnState
          .readAttributes(['switchMode'])
          .then(attrs => {
            this.log('[EP1] read switchMode:', attrs.switchMode);
            if (attrs.switchMode != null) {
              const norm = SWITCH_NORMALIZE(attrs.switchMode);
              return this.setSettings({
                switch_mode:         norm,
                switch_mode_current: SWITCH_DISPLAY[norm] || norm,
              });
            }
          })
          .catch(readAttrCatch(this, '[EP1] readAttributes switchMode'));

        for (const epId of [2, 3]) {
          await zclNode.endpoints[epId].clusters.tuyaPowerOnState
            .readAttributes(['powerOnStateGang'])
            .then(attrs => {
              this.log(`[EP${epId}] read powerOnStateGang:`, attrs.powerOnStateGang);
              if (attrs.powerOnStateGang != null) {
                const v = attrs.powerOnStateGang;
                return this.setSettings({
                  [`power_on_gang${epId}`]:         v,
                  [`power_on_gang${epId}_current`]: POWER_ON_DISPLAY[v] || v,
                });
              }
            })
            .catch(readAttrCatch(this, `[EP${epId}] readAttributes tuyaPowerOnState`));
        }
      }

      // -- First pairing: configure reporting --------------------------------
      if (firstInit) {
        this.log('First init -- configuring onOff reporting on all endpoints');
        for (const epId of [1, 2, 3]) {
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
    for (const key of changedKeys.filter(k => !k.endsWith('_current'))) {
      const value = newSettings[key];

      switch (key) {

        case 'backlight_enabled':
          await this._onSettingBacklight(value);
          break;

        case 'power_on_global': {
          const label    = POWER_ON_DISPLAY[value] || value;
          const siblings = this._getNodeDevices().filter(d => !d._isMainDevice);
          await this.zclNode.endpoints[1].clusters.onOff
            .setGlobalPowerOnState(value)
            .catch(err => this.error('Write powerOnStateGlobal:', err));
          setImmediate(() => {
            this.setSettings({
              power_on_global_current: label,
              power_on_gang1: value, power_on_gang1_current: label,
              power_on_gang2: value, power_on_gang2_current: label,
              power_on_gang3: value, power_on_gang3_current: label,
            }).catch(() => {});
            siblings.forEach(sib => sib.setSettings({
              [`power_on_gang${sib._endpoint}`]:         value,
              [`power_on_gang${sib._endpoint}_current`]: label,
            }).catch(() => {}));
          });
          break;
        }

        case 'indicator_mode':
          this.log(`[EP1] setIndicatorMode → ${value}`);
          await this.zclNode.endpoints[1].clusters.onOff
            .setIndicatorMode(value)
            .then(() => this.log('[EP1] setIndicatorMode OK'))
            .catch(err => { this.error('Write indicatorMode:', err); throw err; });
          break;

        case 'switch_mode':
          await this._onSettingSwitchMode(value, 'switch_mode_current');
          break;

        case 'power_on_gang1':
          await this.zclNode.endpoints[1].clusters.tuyaPowerOnState
            .writeAttributes({ powerOnStateGang: value })
            .catch(err => this.error('Write powerOnStateGang EP1:', err));
          setImmediate(() => this.setSettings({ power_on_gang1_current: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
          break;

        case 'power_on_gang2':
          await this.zclNode.endpoints[2].clusters.tuyaPowerOnState
            .writeAttributes({ powerOnStateGang: value })
            .catch(err => this.error('Write powerOnStateGang EP2:', err));
          setImmediate(() => this.setSettings({ power_on_gang2_current: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
          break;

        case 'power_on_gang3':
          await this.zclNode.endpoints[3].clusters.tuyaPowerOnState
            .writeAttributes({ powerOnStateGang: value })
            .catch(err => this.error('Write powerOnStateGang EP3:', err));
          setImmediate(() => this.setSettings({ power_on_gang3_current: POWER_ON_DISPLAY[value] || value }).catch(() => {}));
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
    this.log(`NovaDigital Switch 3 Gang, ${this._gangLabel} removed`);
  }

}

module.exports = novadigital_switch_3gang;
