'use strict';

const { readAttrCatch } = require('../../lib/errorUtils');
const { BasicSilentBoundCluster } = require('../../lib/TimeCluster');
const {
  TuyaZclBase,
  POWER_ON_DISPLAY,
  SWITCH_DISPLAY,
  SWITCH_NORMALIZE,
} = require('../../lib/TuyaZclBase');

class novadigital_switch_1gang extends TuyaZclBase {

  async onNodeInit({ zclNode }) {

    this.printNode();
    try { if (zclNode.endpoints[1]?.clusters?.basic) zclNode.endpoints[1].bind('basic', new BasicSilentBoundCluster()); } catch {}

    this._endpoint  = 1;
    this._gangLabel = 'Gang 1';

    const firstInit = this.isFirstInit();
    this.log(`[${this._gangLabel}] init -- ${this.getName()} ep:1 firstInit:${firstInit}`);

    // -- OnOff capability ----------------------------------------------------
    const onOffCluster = this._setupOnOffEndpoint(zclNode);
    // -- tuyaPowerOnState listeners (EP1) ------------------------------------
    const gangCluster = zclNode.endpoints[1].clusters.tuyaPowerOnState;

    this._attachGangPowerOnListener(gangCluster, 1, 'power_on_behavior_gang1', 'power_on_current_gang1');

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

    // -- tuyaE000 boot listener (power-restore rejoin signal) ----------------
    this._attachTuyaBootListener(zclNode);

    // -- Availability --------------------------------------------------------
    await this._installAvailability();

    // -- Read basic cluster attributes ---------------------------------------
    await this._readBasicAttributes(zclNode);

    // -- Read extended onOff attrs ------------------------------------------
    await this._readExtendedOnOffAttrs(onOffCluster, 'power_on_behavior_global', 'power_on_current_global');

    // -- Read tuyaPowerOnState (gang + switchMode) — first pairing only ------
    // Device stores these in non-volatile memory; no need to re-read every boot.
    if (firstInit || !this.getSetting('power_on_behavior_gang1')) {
      await this._readGangPowerOnState(gangCluster, 1, 'power_on_behavior_gang1', 'power_on_current_gang1');
    }
    if (firstInit || !this.getSetting('switch_mode_global')) {
      await gangCluster
        .readAttributes(['switchMode'])
        .then(attrs => {
          this.log('[EP1] read switchMode:', attrs.switchMode);
          if (attrs.switchMode != null) {
            const norm = SWITCH_NORMALIZE(attrs.switchMode);
            return this.setSettings({ switch_mode_global: norm, switch_mode_current: SWITCH_DISPLAY[norm] || norm });
          }
        })
        .catch(readAttrCatch(this, '[EP1] readAttributes switchMode'));
    }

    // -- First pairing: configure reporting ----------------------------------
    if (firstInit) {
      this.log('First init -- configuring onOff reporting');
      await this._configureOnOffReporting(zclNode, [1]);
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
          await this._writeGangPowerOnState(1, value, 'power_on_current_gang1');
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
