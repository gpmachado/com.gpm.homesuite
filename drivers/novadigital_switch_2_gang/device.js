'use strict';

const { readAttrCatch } = require('../../lib/errorUtils');
const { BasicSilentBoundCluster } = require('../../lib/TimeCluster');
const {
  TuyaZclBase,
  POWER_ON_DISPLAY,
  SWITCH_DISPLAY,
  SWITCH_NORMALIZE,
} = require('../../lib/TuyaZclBase');

class novadigital_switch_2gang extends TuyaZclBase {

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
    this._setupOnOffEndpoint(zclNode);

    // -- Per-gang: tuyaPowerOnState listeners --------------------------------
    const gangCluster = zclNode.endpoints[this._endpoint].clusters.tuyaPowerOnState;

    if (this._isMainDevice) {
      this._attachGangPowerOnListener(gangCluster, this._endpoint, 'power_on_behavior_gang1', 'power_on_current_gang1');

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
      this._attachGangPowerOnListener(gangCluster, this._endpoint, 'power_on_behavior_gang2', 'power_on_current_gang2');
    }

    // Read gang power-on state — first pairing only (stored in non-volatile memory).
    // On rejoin the device reports it via attr.powerOnStateGang listener automatically.
    const gangBehaviorKey = this._isMainDevice ? 'power_on_behavior_gang1' : 'power_on_behavior_gang2';
    const gangCurrentKey  = this._isMainDevice ? 'power_on_current_gang1'  : 'power_on_current_gang2';
    if (firstInit || !this.getSetting(gangBehaviorKey)) {
      this._readGangPowerOnState(gangCluster, this._endpoint, gangBehaviorKey, gangCurrentKey);
    }

    // -- Main device only (EP1) ----------------------------------------------
    if (this._isMainDevice) {

      const onOffCluster = zclNode.endpoints[1].clusters.onOff;

      // Extended onOff listeners (backlight + powerOnStateGlobal)
      this._attachBacklightListener(onOffCluster);
      this._attachPowerOnGlobalListener(onOffCluster, 'power_on_behavior_global', 'power_on_current_global');
      onOffCluster
        .on('attr.indicatorMode', value => this.log('[EP1] indicatorMode:', value))
        .on('attr.childLock',     value => this.log('[EP1] childLock:', value));

      // Cross-endpoint: keep main device's gang2 current label in sync
      this._attachGangPowerOnListener(
        zclNode.endpoints[2].clusters.tuyaPowerOnState, 2, null, 'power_on_current_gang2'
      );

      this._attachTuyaBootListener(zclNode);

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

        await this._readGangPowerOnState(
          zclNode.endpoints[2].clusters.tuyaPowerOnState, 2, null, 'power_on_current_gang2'
        );
      }

      // -- First pairing: configure reporting --------------------------------
      if (firstInit) {
        this.log('First init -- configuring onOff reporting on all endpoints');
        await this._configureOnOffReporting(zclNode, [1, 2]);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Settings write
  // ---------------------------------------------------------------------------

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // Inching: one write per save regardless of how many inching keys changed (ZBMINIR2 pattern).
    if (changedKeys.some(k => k === 'inching_enabled' || k === 'inching_time')) {
      await this._applyInching({ enable: newSettings.inching_enabled, time: newSettings.inching_time });
    }
    for (const key of changedKeys.filter(k => !k.endsWith('_current') && k !== 'switch_mode_readonly' && k !== 'inching_enabled' && k !== 'inching_time')) {
      const value = newSettings[key];

      switch (key) {

        case 'backlight_enabled':
          await this._onSettingBacklight(value);
          break;

        case 'power_on_behavior_global': {
          const label    = POWER_ON_DISPLAY[value] || value;
          const siblings = this._getNodeDevices().filter(d => !d._isMainDevice);
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
          await this._writeGangPowerOnState(1, value, 'power_on_current_gang1');
          break;

        case 'power_on_behavior_gang2':
          await this._writeGangPowerOnState(2, value, 'power_on_current_gang2');
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
    const siblings = this._getNodeDevices().filter(d => !d._isMainDevice);
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
