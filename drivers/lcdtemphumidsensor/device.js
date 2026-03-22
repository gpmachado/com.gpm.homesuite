'use strict';

/**
 * @file device.js
 * @description LCD Temperature & Humidity Sensor (TS0201 / _TZ3000_ywagc4rj)
 *
 * Device: End Device (sleepy), battery CR2032.
 * Does NOT support configureAttributeReporting -- reports autonomously on change.
 *
 * Conversions:
 *   Temperature : raw / 100  (ZCL standard)
 *   Humidity    : raw / 10   (Tuya-specific, not standard /100)
 *   Battery     : raw / 2    (ZCL standard, 0-200 -> 0-100%)
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');
const { BATTERY_DEVICE_HEARTBEAT_MS, APP_VERSION } = require('../../lib/constants');

const DRIVER_NAME = 'LCD Temp/Humidity Sensor';

class LCDTempHumidSensor extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    // CRITICAL: Call super first to let the ZigBeeDevice framework wire up the registered capabilities.
    await super.onNodeInit({ zclNode });

    this.printNode();
    this.log(`${DRIVER_NAME} v${APP_VERSION} - init`);
    this._registerTemperature();
    this._registerHumidity();
    this._registerBattery();

    // Availability: Cluster6 watchdog — resets on each reportParser call.
    // cluster.on('report') is unreliable in some homey-zigbeedriver versions;
    // calling _markAliveFromAvailability inside reportParser is more robust.
    this._availability = new AvailabilityManagerCluster6(this, {
      timeout: BATTERY_DEVICE_HEARTBEAT_MS,
    });
    await this._availability.install();

    // Silence ZCL time cluster frames (device probes coordinator's time cluster;
    // not used here — suppress binding_unavailable log noise)
    try { zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster()); } catch {}

    this.log(`${DRIVER_NAME} - ready`);
  }

  // 
  // Capability registration
  // 

  /**
   * Register temperature capability.
   * ZCL cluster: TEMPERATURE_MEASUREMENT, attribute: measuredValue
   * Conversion: raw / 100 -> C (ZCL standard).
   * No reportOpts -- end device does not support configureAttributeReporting.
   */
  _registerTemperature() {
    this.registerCapability('measure_temperature', CLUSTER.TEMPERATURE_MEASUREMENT, {
      report: 'measuredValue',
      reportParser: (value) => {
        this._markAliveFromAvailability?.('temperature');
        const result = Math.round((value / 100) * 10) / 10;
        this.log(`[Temp] ${result}C`);
        return result;
      },
    });
  }

  /**
   * Register humidity capability.
   * ZCL cluster: RELATIVE_HUMIDITY_MEASUREMENT, attribute: measuredValue
   * Conversion: raw / 10 -> % (Tuya-specific, standard would be /100).
   * No reportOpts -- end device does not support configureAttributeReporting.
   */
  _registerHumidity() {
    this.registerCapability('measure_humidity', CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT, {
      report: 'measuredValue',
      reportParser: (value) => {
        this._markAliveFromAvailability?.('humidity');
        const result = Math.round(Math.min(100, Math.max(0, value / 10)) * 10) / 10;
        this.log(`[Humidity] ${result}%`);
        return result;
      },
    });
  }

  /**
   * Register battery capability.
   * ZCL cluster: POWER_CONFIGURATION, attribute: batteryPercentageRemaining
   */
  _registerBattery() {
    this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
      report: 'batteryPercentageRemaining',
      reportParser: (value) => {
        this._markAliveFromAvailability?.('battery');
        const result = Math.min(100, Math.max(0, Math.round(value / 2)));
        this.log(`[Battery] ${result}%`);
        return result;
      },
    });
  }

  //
  // Availability monitoring
  // 

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._markAliveFromAvailability?.('endDeviceAnnounce');
  }

  // 
  // Settings
  // 

  /**
   * Handle settings changes.
   *
   * @param {Object} params
   * @param {Object} params.oldSettings
   * @param {Object} params.newSettings
   * @param {string[]} params.changedKeys
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('[Settings] Changed:', changedKeys);


  }

  // 
  // Lifecycle
  // 

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }
}

module.exports = LCDTempHumidSensor;
