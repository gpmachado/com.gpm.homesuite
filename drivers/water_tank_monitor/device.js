'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

const DATA_POINTS = {
  LIQUID_STATE: 1,
  LIQUID_DEPTH: 2,
  MAX_LEVEL: 7,
  MIN_LEVEL: 8,
  INSTALLATION_HEIGHT: 19,
  FULL_LEVEL_DISTANCE: 21,
  LIQUID_PERCENTAGE: 22,
};

const LIQUID_STATES = {
  0: 'normal',
  1: 'low',
  2: 'high',
};

class WaterTankMonitorDevice extends TuyaSpecificClusterDevice {

  async onNodeInit(props) {
    await super.onNodeInit(props);

    // The device can be quiet for long periods when the surface is stable.
    // A 12-hour timeout avoids treating normal end-device silence as offline.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: 12 * 60 * 60 * 1000,
      pollBeforeOffline: false,
    });
    await this._availability.install();

    const tuyaCluster = this.zclNode?.endpoints?.[this.tuyaEndpoint]?.clusters?.tuya;
    if (!tuyaCluster) {
      this.error('[WaterLevel] Tuya cluster 0xEF00 is unavailable');
      return;
    }

    this._lastPublished = {};
    this._onDataPoint = this._handleDataPoint.bind(this);

    for (const event of ['datapoint', 'reporting', 'response', 'reportingConfiguration']) {
      tuyaCluster.on(event, this._onDataPoint);
    }

    this._onTimeRequest = request => {
      this.sendTimeResponse(request, { waitForResponse: false })
        .catch(error => this.error('[WaterLevel] Time response failed:', error.message));
    };
    tuyaCluster.on('timeRequest', this._onTimeRequest);

    this.log('[WaterLevel] TS0601 / _TZE200_lvkk0hdg initialized');
  }

  async _handleDataPoint(data) {
    if (!data || !Number.isInteger(data.dp) || data.datatype === undefined || !data.data) {
      this.log('[WaterLevel] Ignoring malformed Tuya datapoint');
      return;
    }

    let value;
    try {
      value = this._parseDataValue(data);
    } catch (error) {
      this.error(`[WaterLevel] Could not decode DP${data.dp}:`, error.message);
      return;
    }

    this._debugLog(
      `DP${data.dp} type=${data.datatype} value=${this._formatValue(value)}`,
    );

    switch (data.dp) {
      case DATA_POINTS.LIQUID_STATE:
        await this._updateLiquidState(value);
        break;

      case DATA_POINTS.LIQUID_DEPTH:
        await this._publishMeasurement(
          'measure_water_level',
          value,
          0,
          400,
          'depth_change_threshold',
          0,
        );
        break;

      case DATA_POINTS.LIQUID_PERCENTAGE:
        await this._publishMeasurement(
          'measure_water_percentage',
          value,
          0,
          100,
          'level_change_threshold',
          0,
        );
        break;

      case DATA_POINTS.MAX_LEVEL:
        this.log(`[WaterLevel] Configured high threshold: ${value}%`);
        await this._syncSetting('upper_limit', value);
        break;

      case DATA_POINTS.MIN_LEVEL:
        this.log(`[WaterLevel] Configured low threshold: ${value}%`);
        await this._syncSetting('lower_limit', value);
        break;

      case DATA_POINTS.INSTALLATION_HEIGHT:
        this.log(`[WaterLevel] Installation height: ${value} mm`);
        await this._syncSetting('installation_height', value);
        break;

      case DATA_POINTS.FULL_LEVEL_DISTANCE:
        this.log(`[WaterLevel] Sensor-to-full distance: ${value} mm`);
        await this._syncSetting('full_level_distance', value);
        break;

      default:
        this.log(`[WaterLevel] Unhandled DP${data.dp}`);
    }
  }

  async _publishMeasurement(capability, value, min, max, thresholdSetting, defaultThreshold) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < min || numericValue > max) {
      this.log(`[WaterLevel] Ignoring invalid ${capability}: ${value}`);
      return;
    }

    const settings = this.getSettings();
    const threshold = this._numberSetting(settings[thresholdSetting], defaultThreshold);
    const minimumIntervalMs = this._numberSetting(settings.minimum_update_interval, 0) * 1000;
    const previous = this._lastPublished[capability];

    if (previous) {
      const difference = Math.abs(numericValue - previous.value);
      if (difference < threshold) {
        this._debugLog(
          `Suppressed ${capability}: change ${difference} is below ${threshold}`,
        );
        return;
      }

      const elapsed = Date.now() - previous.timestamp;
      if (elapsed < minimumIntervalMs) {
        this._debugLog(
          `Suppressed ${capability}: ${elapsed}ms is below ${minimumIntervalMs}ms`,
        );
        return;
      }
    }

    if (await this._setCapabilityValue(capability, numericValue)) {
      this._lastPublished[capability] = {
        value: numericValue,
        timestamp: Date.now(),
      };
    }
  }

  async _updateLiquidState(value) {
    const numericValue = Number(value);
    const state = LIQUID_STATES[numericValue];
    if (!state) {
      this.log(`[WaterLevel] Unknown liquid state: ${value}`);
      return;
    }

    if (this._lastLiquidState === numericValue) {
      this._debugLog(`Suppressed unchanged liquid state: ${state}`);
      return;
    }
    this._lastLiquidState = numericValue;

    this.log(`[WaterLevel] Liquid state: ${state}`);
    await Promise.all([
      this._setCapabilityValue('alarm_water_low', numericValue === 1),
      this._setCapabilityValue('alarm_water_high', numericValue === 2),
    ]);
  }

  async _setCapabilityValue(capability, value) {
    if (!this.hasCapability(capability)) return false;
    if (this.getCapabilityValue(capability) === value) return true;
    try {
      await this.setCapabilityValue(capability, value);
      return true;
    } catch (error) {
      this.error(`[WaterLevel] Failed to update ${capability}:`, error.message);
      return false;
    }
  }

  async _syncSetting(key, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || this.getSetting(key) === numericValue) return;

    try {
      await this.setSettings({ [key]: numericValue });
    } catch (error) {
      this.log(`[WaterLevel] Could not sync setting ${key}: ${error.message}`);
    }
  }

  _numberSetting(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  _formatValue(value) {
    return Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  }

  _debugLog(message) {
    if (this.getSetting('debug_logging') === true) {
      this.log(`[WaterLevel] ${message}`);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    const lowerLimit = Number(newSettings.lower_limit);
    const upperLimit = Number(newSettings.upper_limit);
    const installationHeight = Number(newSettings.installation_height);
    const fullLevelDistance = Number(newSettings.full_level_distance);

    if (lowerLimit >= upperLimit) {
      throw new Error('The low threshold must be lower than the high threshold.');
    }
    if (fullLevelDistance >= installationHeight) {
      throw new Error('The full-level distance must be lower than the tank height.');
    }

    const writableSettings = {
      upper_limit: {
        dp: DATA_POINTS.MAX_LEVEL,
        label: 'high threshold',
      },
      lower_limit: {
        dp: DATA_POINTS.MIN_LEVEL,
        label: 'low threshold',
      },
      installation_height: {
        dp: DATA_POINTS.INSTALLATION_HEIGHT,
        label: 'installation height',
      },
      full_level_distance: {
        dp: DATA_POINTS.FULL_LEVEL_DISTANCE,
        label: 'full-level distance',
      },
    };

    for (const key of changedKeys) {
      const definition = writableSettings[key];
      if (!definition) continue;

      const value = Number(newSettings[key]);
      await this.writeData32(definition.dp, value);
      this.log(
        `[WaterLevel] Updated ${definition.label}: ${value} (DP${definition.dp})`,
      );
    }

    if (changedKeys.some(key => writableSettings[key])) {
      const tuyaCluster = this.zclNode?.endpoints?.[this.tuyaEndpoint]?.clusters?.tuya;
      tuyaCluster?.dataQuery({}, { waitForResponse: false })
        .catch(error => this.log('[WaterLevel] Settings readback deferred:', error.message));
    }
  }

  async _teardown() {
    const tuyaCluster = this.zclNode?.endpoints?.[this.tuyaEndpoint]?.clusters?.tuya;
    if (tuyaCluster && this._onDataPoint) {
      for (const event of ['datapoint', 'reporting', 'response', 'reportingConfiguration']) {
        tuyaCluster.removeListener(event, this._onDataPoint);
      }
    }
    if (tuyaCluster && this._onTimeRequest) {
      tuyaCluster.removeListener('timeRequest', this._onTimeRequest);
    }
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('[WaterLevel] Device removed');
  }
}

module.exports = WaterTankMonitorDevice;
