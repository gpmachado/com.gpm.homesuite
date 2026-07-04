'use strict';

const { readAttrCatch } = require('./errorUtils');
const { BasicSilentBoundCluster } = require('./TimeCluster');
const {
  TuyaZclBase,
  POWER_ON_DISPLAY,
} = require('./TuyaZclBase');
const {
  normalizePowerOnState,
  getPowerOnLabel,
} = require('./ZclOnOffSettings');

/**
 * Shared implementation for TS0002/TS0003 inline relay modules.
 *
 * These modules expose one Zigbee endpoint per relay, but have no wall-switch
 * controls. Deliberately omitted: backlight, switch mode and LED indicator.
 */
class TuyaRelayMultiGangBase extends TuyaZclBase {

  get gangCount() {
    throw new Error('gangCount must be implemented by the relay driver');
  }

  get relayName() {
    return `${this.gangCount}CH Relay Module`;
  }

  async onNodeInit({ zclNode }) {
    this.printNode();
    try {
      if (zclNode.endpoints[1]?.clusters?.basic) {
        zclNode.endpoints[1].bind('basic', new BasicSilentBoundCluster());
      }
    } catch {}
    this._bindSilentTimeCluster(zclNode);

    const { subDeviceId } = this.getData();
    const endpointBySubDevice = {
      secondSwitch: 2,
      thirdSwitch: 3,
    };
    this._endpoint = endpointBySubDevice[subDeviceId] || 1;
    this._isMainDevice = !subDeviceId;
    this._gangLabel = this._isMainDevice
      ? 'Main (Gang 1)'
      : `Gang ${this._endpoint}`;

    const firstInit = this.isFirstInit();
    this.log(
      `[${this._gangLabel}] init -- ${this.getName()} `
      + `ep:${this._endpoint} firstInit:${firstInit}`,
    );

    this._setupOnOffEndpoint(zclNode);

    const gangCluster = zclNode.endpoints[this._endpoint].clusters.tuyaPowerOnState;
    const behaviorKey = `power_on_behavior_gang${this._endpoint}`;
    const currentKey = `power_on_current_gang${this._endpoint}`;
    if (gangCluster) {
      this._attachGangPowerOnListener(
        gangCluster,
        this._endpoint,
        behaviorKey,
        currentKey,
      );
      if (firstInit || !this.getSetting(behaviorKey)) {
        await this._readGangPowerOnState(
          gangCluster,
          this._endpoint,
          behaviorKey,
          currentKey,
        );
      }
    } else {
      this.log(`[EP${this._endpoint}] cluster 0xE001 unavailable`);
    }

    if (!this._isMainDevice) return;

    const onOffCluster = zclNode.endpoints[1].clusters.onOff;
    this._attachPowerOnGlobalListener(
      onOffCluster,
      'power_on_behavior_global',
      'power_on_current_global',
    );

    for (let endpoint = 2; endpoint <= this.gangCount; endpoint += 1) {
      const endpointCluster = zclNode.endpoints[endpoint].clusters.tuyaPowerOnState;
      if (endpointCluster) {
        this._attachGangPowerOnListener(
          endpointCluster,
          endpoint,
          null,
          `power_on_current_gang${endpoint}`,
        );
      }
    }

    this._attachTuyaBootListener(zclNode);
    await this._installAvailability();
    await this._readBasicAttributes(zclNode);
    await this._updateSiblingNames();
    await this._readGlobalPowerOnState(onOffCluster, firstInit);

    if (firstInit) {
      const endpoints = Array.from(
        { length: this.gangCount },
        (_, index) => index + 1,
      );
      this.log('First init -- configuring onOff reporting on all endpoints');
      await this._configureOnOffReporting(zclNode, endpoints);
    }
  }

  async _readGlobalPowerOnState(onOffCluster, firstInit) {
    if (!firstInit && this.getSetting('power_on_behavior_global')) return;

    await onOffCluster
      .readAttributes(['powerOnStateGlobal'])
      .then(attrs => {
        if (attrs.powerOnStateGlobal == null) return null;
        const value = normalizePowerOnState(attrs.powerOnStateGlobal);
        return this.setSettings({
          power_on_behavior_global: value,
          power_on_current_global: getPowerOnLabel(value),
        });
      })
      .catch(readAttrCatch(this, '[EP1] readAttributes powerOnStateGlobal'));
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some(
      key => key === 'inching_enabled' || key === 'inching_time',
    )) {
      if (!this.zclNode.endpoints[1].clusters.tuyaE000) {
        throw new Error('Inching is not supported by this relay firmware');
      }
      await this._applyInching({
        enable: newSettings.inching_enabled,
        time: newSettings.inching_time,
      });
    }

    for (const key of changedKeys) {
      if (
        key.endsWith('_current')
        || key === 'inching_enabled'
        || key === 'inching_time'
        || key === 'device_siblings_info'
      ) continue;

      const value = newSettings[key];

      if (key === 'power_on_behavior_global') {
        await this._writeGlobalPowerOnState(value);
        continue;
      }

      const gangMatch = key.match(/^power_on_behavior_gang(\d+)$/);
      if (gangMatch) {
        const endpoint = Number(gangMatch[1]);
        if (!this.zclNode.endpoints[endpoint].clusters.tuyaPowerOnState) {
          throw new Error(
            `Power-on behavior is not supported on relay ${endpoint}`,
          );
        }
        await this._writeGangPowerOnState(
          endpoint,
          value,
          `power_on_current_gang${endpoint}`,
        );
        continue;
      }

      this.log(`Unknown setting key: ${key}`);
    }
  }

  async _writeGlobalPowerOnState(value) {
    const label = POWER_ON_DISPLAY[value] || value;
    await this.zclNode.endpoints[1].clusters.onOff
      .setGlobalPowerOnState(value)
      .catch(err => this.error('Write powerOnStateGlobal:', err));

    setImmediate(() => {
      const mainPatch = {
        power_on_current_global: label,
        power_on_behavior_gang1: value,
        power_on_current_gang1: label,
      };
      for (let endpoint = 2; endpoint <= this.gangCount; endpoint += 1) {
        mainPatch[`power_on_current_gang${endpoint}`] = label;
      }
      this.setSettings(mainPatch).catch(() => {});

      this._getNodeDevices()
        .filter(device => !device._isMainDevice)
        .forEach(device => device.setSettings({
          [`power_on_behavior_gang${device._endpoint}`]: value,
          [`power_on_current_gang${device._endpoint}`]: label,
        }).catch(() => {}));
    });
  }

  onDeleted() {
    super.onDeleted();
    this.log(`${this.relayName}, ${this._gangLabel} removed`);
  }

}

module.exports = TuyaRelayMultiGangBase;
