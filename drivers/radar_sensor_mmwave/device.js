'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const IASZoneHelper = require('../../lib/IASZoneHelper');

const DATA_POINTS = {
  PRESENCE_STATE: 1,
  SENSITIVITY: 2,
  MINIMUM_RANGE: 3,
  MAXIMUM_RANGE: 4,
  TARGET_DISTANCE: 9,
  FADING_TIME: 101,
  // Illuminance — multiple possible DPs per firmware variant (from Hubitat profiles)
  ILLUMINANCE_106: 106,
  ILLUMINANCE_104: 104,
  ILLUMINANCE_20: 20,
  ILLUMINANCE_12: 12,
  ILLUMINANCE_181: 181,
};

const MANU_ATTR = {
  PRESENCE_KEEP_TIME: 57345,
  MOTION_SENSITIVITY: 57348,
  STATIC_SENSITIVITY: 57349,
  LED_INDICATOR: 57353,
  TARGET_DISTANCE: 57354,
  MOTION_DETECTION_DISTANCE: 57355,
};

const STATS_REFRESH_MS = 5 * 60 * 1000;

class RadarSensorMmwaveDevice extends TuyaSpecificClusterDevice {

  async onNodeInit(props) {
    await super.onNodeInit(props);

    this._errorCount = 0;
    this._lastErrorAt = null;
    this._errorsByDp = {};
    this._initAt = Date.now();
    this._lastTargetDistance = null;
    this._presenceKeepTime = null;
    this._occupied = null;

    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: 12 * 60 * 60 * 1000,
      pollBeforeOffline: false,
    });
    await this._availability.install();

    const ep = this.zclNode?.endpoints?.[this.tuyaEndpoint];

    // Same initialization read as Zigbee2MQTT's configureMagicPacket. This
    // TS0225 can keep sending IAS occupancy while its illuminance and 0xE002
    // attribute reports remain dormant until this Basic-cluster read occurs.
    this._configureTuyaReporting(ep).catch(error => {
      this.log('[mmWave] Tuya reporting initialization deferred:', error.message);
    });

    // ── Tuya 0xEF00 DP protocol ──
    const tuyaCluster = ep?.clusters?.tuya;
    if (tuyaCluster) {
      this._onDataPoint = this._handleDataPoint.bind(this);
      for (const event of ['datapoint', 'reporting', 'response', 'reportingConfiguration']) {
        tuyaCluster.on(event, this._onDataPoint);
      }

      this._onTimeRequest = request => {
        this.sendTimeResponse(request, { waitForResponse: false })
          .catch(error => this.error('[mmWave] Time response failed:', error.message));
      };
      tuyaCluster.on('timeRequest', this._onTimeRequest);

      this.homey.setTimeout(() => {
        tuyaCluster.dataQuery({}, { waitForResponse: false })
          .catch(error => this.log('[mmWave] Data query deferred:', error.message));
      }, 20000);
    } else {
      this.error('[mmWave] Tuya cluster 0xEF00 is unavailable');
    }

    // ── IAS Zone: presence / motion (cluster 0x0500) ──
    // Deferred — device takes ~15s to become reachable after power-on
    this._iasHelper = new IASZoneHelper(this, {
      endpointId: this.tuyaEndpoint,
      sendEnrollOnInit: true,
      readInitialState: true,
      configureCieAddress: false,
      onStatus: (zoneStatus, ctx) => {
        this.log(`[mmWave] IAS zoneStatus [${ctx.source}]:`, zoneStatus);
        const occupied = IASZoneHelper.hasAlarm(zoneStatus);
        this._occupied = occupied;
        this._setCapabilityValue('alarm_occupancy', occupied);
        if (!occupied) {
          this._presenceKeepTime = 0;
          this._setCapabilityValue('presence_keep_time', 0);
        }
      },
    });

    this.homey.setTimeout(() => {
      this._iasHelper.init(this.zclNode).catch(err => {
        this.log('[mmWave] IAS init deferred:', err.message);
      });
    }, 15000);

    // ── manuSpecificTuya3 0xE002: attribute reports (distance, sensitivity) ──
    this._manuTuyaValues = {};
    this._manuTuyaListeners = [];
    const manuCluster = ep?.clusters?.manuSpecificTuya3 || ep?.clusters?.[57346];
    if (manuCluster && typeof manuCluster.on === 'function') {
      const attrEvents = {
        presenceKeepTime: MANU_ATTR.PRESENCE_KEEP_TIME,
        motionSensitivity: MANU_ATTR.MOTION_SENSITIVITY,
        staticSensitivity: MANU_ATTR.STATIC_SENSITIVITY,
        ledIndicator: MANU_ATTR.LED_INDICATOR,
        targetDistance: MANU_ATTR.TARGET_DISTANCE,
        motionDetectionDistance: MANU_ATTR.MOTION_DETECTION_DISTANCE,
      };

      for (const [name, attrId] of Object.entries(attrEvents)) {
        const handler = value => {
          this._manuTuyaValues[attrId] = value;
          this._handleManuTuyaAttr(attrId, value, name);
        };
        manuCluster.on(`attr.${name}`, handler);
        this._manuTuyaListeners.push({ event: `attr.${name}`, handler });
      }
    }

    // ── IlluminanceMeasurement 0x0400 (only if device supports it) ──
    const illumCluster = ep?.clusters?.illuminanceMeasurement;
    if (illumCluster && typeof illumCluster.on === 'function') {
      this._onIllumAttr = value => this._handleIlluminanceValue(value, 'report');
      illumCluster.on('attr.measuredValue', this._onIllumAttr);
    } else {
      this.log('[mmWave] Illuminance cluster 0x0400 is unavailable');
    }

    this.log('[mmWave] TS0225 / _TZ3218_t9ynfz4x initialized');

    // Defer first stats refresh so device settings are fully registered
    this._statsTimer = this.homey.setTimeout(() => {
      this._refreshStatsLabel().catch(() => {});
      this._statsTimer = this.homey.setInterval(() => {
        this._refreshStatsLabel().catch(() => {});
      }, STATS_REFRESH_MS);
    }, 10000);
  }

  async _configureTuyaReporting(endpoint) {
    const basicCluster = endpoint?.clusters?.basic;
    if (!basicCluster?.readAttributes) {
      throw new Error('Basic cluster 0x0000 is unavailable');
    }

    try {
      await basicCluster.readAttributes([
        'manufacturerName',
        'zclVersion',
        'appVersion',
        'modelId',
        'powerSource',
        'attributeReportingStatus',
      ]);
      this.log('[mmWave] Tuya reporting initialization completed');
    } catch (error) {
      // Some firmware revisions reject one or more attributes. The request
      // itself is the initialization trigger, so keep listening for reports.
      this.log('[mmWave] Tuya reporting initialization sent:', error.message);
    }
  }

  _trackError(dp, msg) {
    this._errorCount++;
    this._lastErrorAt = Date.now();
    const key = String(dp);
    this._errorsByDp[key] = (this._errorsByDp[key] || 0) + 1;
    this.error(`[mmWave] Error DP${dp}: ${msg} (total errors: ${this._errorCount})`);
  }

  async _handleDataPoint(data) {
    if (!data || !Number.isInteger(data.dp) || data.datatype === undefined || !data.data) {
      this.log('[mmWave] Ignoring malformed Tuya datapoint');
      return;
    }

    let value;
    try {
      value = this._parseDataValue(data);
    } catch (error) {
      this._trackError(data.dp, `decode: ${error.message}`);
      return;
    }

    this._debugLog(`DP${data.dp} type=${data.datatype} value=${this._formatValue(value)}`);

    switch (data.dp) {
      case DATA_POINTS.PRESENCE_STATE:
        this.log('[mmWave] presence state:', value);
        this._occupied = Boolean(value);
        await this._setCapabilityValue('alarm_occupancy', this._occupied);
        if (!this._occupied) {
          this._presenceKeepTime = 0;
          await this._setCapabilityValue('presence_keep_time', 0);
        }
        break;

      case DATA_POINTS.SENSITIVITY:
        this.log('[mmWave] sensitivity:', value);
        break;

      case DATA_POINTS.MINIMUM_RANGE:
        this.log('[mmWave] minimum range:', value, 'cm');
        break;

      case DATA_POINTS.MAXIMUM_RANGE:
        this.log('[mmWave] maximum range:', value, 'cm');
        break;

      case DATA_POINTS.TARGET_DISTANCE:
        this.log('[mmWave] target distance:', value, 'cm');
        break;

      case DATA_POINTS.FADING_TIME:
        this.log('[mmWave] fading time:', value, 's');
        break;

      case DATA_POINTS.ILLUMINANCE_106:
      case DATA_POINTS.ILLUMINANCE_104:
      case DATA_POINTS.ILLUMINANCE_20:
      case DATA_POINTS.ILLUMINANCE_12:
      case DATA_POINTS.ILLUMINANCE_181:
        this.log(`[mmWave] illuminance DP${data.dp} raw:`, value);
        await this._setCapabilityValue('measure_luminance', Math.round(value / 10));
        break;

      default:
        this.log(`[mmWave] Unhandled DP${data.dp}:`, value);
    }
  }

  async _setCapabilityValue(capability, value) {
    if (!this.hasCapability(capability)) return false;
    if (this.getCapabilityValue(capability) === value) return true;

    if (capability === 'measure_luminance') {
      const threshold = Number(this.getSetting('luminance_change_threshold')) || 0;
      const prev = this.getCapabilityValue(capability);
      if (prev != null && threshold > 0 && Math.abs(prev - value) < threshold) {
        return true;
      }
    }

    try {
      await this.setCapabilityValue(capability, value);
      return true;
    } catch (error) {
      this._trackError(-1, `setCap ${capability}: ${error.message}`);
      return false;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    const manuCluster = this.zclNode?.endpoints?.[this.tuyaEndpoint]?.clusters?.manuSpecificTuya3;

    // ── manuTuya3 attribute writes (Linptech-native path) ──
    if (changedKeys.includes('motion_sensitivity') && manuCluster?.writeAttributes) {
      try {
        await manuCluster.writeAttributes({ motionSensitivity: Number(newSettings.motion_sensitivity) });
        this.log('[mmWave] Wrote motion sensitivity via manuTuya3');
      } catch (e) {
        this.log('[mmWave] manuTuya3 motion sensitivity write skipped:', e.message);
      }
    }

    if (changedKeys.includes('static_sensitivity') && manuCluster?.writeAttributes) {
      try {
        await manuCluster.writeAttributes({ staticSensitivity: Number(newSettings.static_sensitivity) });
        this.log('[mmWave] Wrote static sensitivity via manuTuya3');
      } catch (e) {
        this.log('[mmWave] manuTuya3 static sensitivity write skipped:', e.message);
      }
    }

    if (changedKeys.includes('motion_detection_distance') && manuCluster?.writeAttributes) {
      try {
        await manuCluster.writeAttributes({ motionDetectionDistance: Number(newSettings.motion_detection_distance) });
        this.log('[mmWave] Wrote motion detection distance via manuTuya3');
      } catch (e) {
        this.log('[mmWave] manuTuya3 detection distance write skipped:', e.message);
      }
    }

    if (changedKeys.includes('led_indicator') && manuCluster?.writeAttributes) {
      try {
        await manuCluster.writeAttributes({ ledIndicator: newSettings.led_indicator ? 1 : 0 });
        this.log('[mmWave] Wrote led indicator via manuTuya3:', newSettings.led_indicator);
      } catch (e) {
        this.log('[mmWave] manuTuya3 led indicator write skipped:', e.message);
      }
    }

    // ── Tuya DP writes ──
    const dpSettings = {
      fading_time: { dp: DATA_POINTS.FADING_TIME, label: 'fading time' },
    };

    for (const key of changedKeys) {
      const def = dpSettings[key];
      if (!def) continue;
      try {
        await this.writeData32(def.dp, Number(newSettings[key]));
        this.log(`[mmWave] Updated ${def.label}: ${newSettings[key]} (DP${def.dp})`);
      } catch (error) {
        this._trackError(def.dp, `write: ${error.message}`);
      }
    }

    if (changedKeys.some(k => dpSettings[k])) {
      const tuyaCluster = this.zclNode?.endpoints?.[this.tuyaEndpoint]?.clusters?.tuya;
      tuyaCluster?.dataQuery({}, { waitForResponse: false })
        .catch(error => this.log('[mmWave] Settings readback deferred:', error.message));
    }

  }

  async _refreshStatsLabel() {
    try {
      const stats = this._availability?.getMessageStats?.() || {};
      const uptime = Math.round((Date.now() - this._initAt) / 360000) / 10;
      const lastMsg = stats.lastMessageAt
        ? Math.round((Date.now() - stats.lastMessageAt) / 60000)
        : null;

      const topErrors = Object.entries(this._errorsByDp)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([dp, n]) => `DP${dp}×${n}`)
        .join(', ');

      const display = [
        `Msg: ${stats.last24h || 0}/24h (${stats.averagePerHour || 0}/h)`,
        this._lastTargetDistance != null ? `Dist: ${this._lastTargetDistance}cm` : '',
        this._presenceKeepTime != null ? `Pres: ${this._presenceKeepTime}min` : '',
        `Err: ${this._errorCount}${topErrors ? ` [${topErrors}]` : ''}`,
        lastMsg != null ? `Last: ${lastMsg}min ago` : 'Last: never',
        `Up: ${uptime}h`,
      ].filter(Boolean).join(' | ');

      await this.setSettings({ device_stats_display: display });
    } catch (e) {
      this.log('[mmWave] Stats refresh error:', e.message);
    }
  }

  _formatValue(value) {
    return Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  }

  _handleManuTuyaAttr(attrId, value, key) {
    this._debugLog(`manuTuya3 attr.${attrId} [${key}]: ${value}`);

    switch (attrId) {
      case MANU_ATTR.TARGET_DISTANCE:
        this._lastTargetDistance = value;
        this._setCapabilityValue('measure_distance', Math.round(value / 100 * 10) / 10);
        this.log('[mmWave] target distance:', value, 'cm');
        break;

      case MANU_ATTR.MOTION_DETECTION_DISTANCE:
        this.log('[mmWave] motion detection distance:', value, 'cm');
        break;

      case MANU_ATTR.PRESENCE_KEEP_TIME:
        // The device may deliver the duration report just after occupancy has
        // cleared. Keep Homey's state coherent with the physical semantics:
        // no occupancy always means zero accumulated presence time.
        this._presenceKeepTime = this._occupied === false ? 0 : value;
        this._setCapabilityValue('presence_keep_time', this._presenceKeepTime);
        this._debugLog(`presence keep time: ${this._presenceKeepTime}min`);
        break;

      case MANU_ATTR.MOTION_SENSITIVITY:
        this.log('[mmWave] motion sensitivity:', value);
        break;

      case MANU_ATTR.STATIC_SENSITIVITY:
        this.log('[mmWave] static sensitivity:', value);
        break;

      case MANU_ATTR.LED_INDICATOR:
        this.log('[mmWave] led indicator:', value ? 'ON' : 'OFF');
        break;
    }
  }

  _convertIlluminance(measuredValue) {
    if (measuredValue === 0) return 0;
    return Math.round(10 ** ((measuredValue - 1) / 10000));
  }

  _handleIlluminanceValue(value, source) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;

    const lux = this._convertIlluminance(numericValue);
    this.log(`[mmWave] illuminance (${source}):`, lux, 'lx (raw:', numericValue, ')');
    this._setCapabilityValue('measure_luminance', lux);
  }

  _debugLog(message) {
    if (this.getSetting('debug_logging') === true) {
      this.log(`[mmWave] ${message}`);
    }
  }

  async _teardown() {
    if (this._statsTimer) {
      this.homey.clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
    if (this._iasHelper) {
      this._iasHelper.dispose();
      this._iasHelper = null;
    }
    const ep = this.zclNode?.endpoints?.[this.tuyaEndpoint];

    const illumCluster = ep?.clusters?.illuminanceMeasurement;
    if (illumCluster && this._onIllumAttr) {
      illumCluster.removeListener('attr.measuredValue', this._onIllumAttr);
      this._onIllumAttr = null;
    }

    const manuCluster = ep?.clusters?.manuSpecificTuya3 || ep?.clusters?.[57346];
    if (manuCluster && this._manuTuyaListeners) {
      for (const { event, handler } of this._manuTuyaListeners) {
        manuCluster.removeListener(event, handler);
      }
      this._manuTuyaListeners = [];
    }
    const tuyaCluster = ep?.clusters?.tuya;
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
    this.log('[mmWave] Device removed');
  }

}

module.exports = RadarSensorMmwaveDevice;
