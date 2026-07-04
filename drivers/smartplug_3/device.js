'use strict';

/**
 * Diagnostic driver for TS011F / _TZ3000_cehuw1lw.
 *
 * It reuses the raw-frame diagnostics from smartplug_2 and applies conservative
 * reporting intervals to suppress the firmware's three-frame bursts.
 */

const { Cluster } = require('zigbee-clusters');
const SmartPlugDiagnosticDevice = require('../smartplug_2/device');

const POLL_INTERVAL_SECONDS = 600;
const REDUCED_REPORTING = {
  onOff: { minInterval: 2, maxInterval: 600, minChange: 1 },
  activePower: { minInterval: 30, maxInterval: 600, minChange: 5 },
  rmsCurrent: { minInterval: 30, maxInterval: 600, minChange: 50 },
  rmsVoltage: { minInterval: 60, maxInterval: 900, minChange: 2 },
  currentSummationDelivered: {
    minInterval: 60,
    maxInterval: 900,
    minChange: 1,
  },
};
const ACTIVE_POWER_ATTRIBUTE_ID = 0x050B;
const UINT16_DATA_TYPE_ID = 0x21;

class SmartPlug3Device extends SmartPlugDiagnosticDevice {

  get diagnosticTag() {
    return 'SP3';
  }

  get diagnosticManufacturer() {
    return '_TZ3000_cehuw1lw';
  }

  async onNodeInit(args) {
    const configuredPollInterval = Number(this.getSetting('pollInterval'));
    if (
      !Number.isFinite(configuredPollInterval)
      || configuredPollInterval < POLL_INTERVAL_SECONDS
    ) {
      await this.setSettings({
        pollInterval: POLL_INTERVAL_SECONDS,
      }).catch(err => {
        this.error('[SP3 settings] Could not update polling interval:', err.message);
      });
    }

    await super.onNodeInit(args);
  }

  /**
   * This firmware reports activePower correctly (13 W and 16 W observed with
   * a small LED load), while rmsCurrent may remain zero. Using V × A would
   * therefore overwrite valid power reports with 0 W.
   */
  async _loadSettings() {
    await super._loadSettings();
    this._calcPower = false;
  }

  async _safeSetupAttributeReporting() {
    const endpoint = this.zclNode.endpoints[1];

    try {
      await endpoint.clusters.onOff.configureReporting({
        onOff: REDUCED_REPORTING.onOff,
      });
      this.log(
        `[SP3 reporting] onOff configure accepted: ${
          JSON.stringify(REDUCED_REPORTING.onOff)
        }`,
      );
    } catch (err) {
      this.log(`[SP3 reporting] onOff configure failed (${err.message})`);
    }

    try {
      await endpoint.clusters.electricalMeasurement.configureReporting({
        rmsCurrent: REDUCED_REPORTING.rmsCurrent,
        rmsVoltage: REDUCED_REPORTING.rmsVoltage,
      });
      this.log(
        `[SP3 reporting] electricalMeasurement configure accepted: ${
          JSON.stringify({
            rmsCurrent: REDUCED_REPORTING.rmsCurrent,
            rmsVoltage: REDUCED_REPORTING.rmsVoltage,
          })
        }`,
      );
    } catch (err) {
      this.log(`[SP3 reporting] electricalMeasurement configure failed (${err.message})`);
    }

    // This TS011F variant declares activePower as uint16 (0x21), contrary to
    // the standard Electrical Measurement definition (int16 / 0x29). Calling
    // the regular configureReporting API therefore returns INVALID_DATA_TYPE.
    // Use the library's low-level global command with the type reported by the
    // device, without modifying the shared cluster definition used by every
    // other smart plug.
    try {
      const lowLevelConfigureReporting =
        Object.getPrototypeOf(Cluster.prototype).configureReporting;
      const { reports = [] } = await lowLevelConfigureReporting.call(
        endpoint.clusters.electricalMeasurement,
        {
          reports: [{
            direction: 'reported',
            attributeId: ACTIVE_POWER_ATTRIBUTE_ID,
            attributeDataType: UINT16_DATA_TYPE_ID,
            ...REDUCED_REPORTING.activePower,
          }],
        },
      );
      const failed = reports.find(result => result.status !== 'SUCCESS');
      if (failed) throw new Error(failed.status);
      this.log(
        `[SP3 reporting] activePower uint16 configure accepted: ${
          JSON.stringify(REDUCED_REPORTING.activePower)
        }`,
      );
    } catch (err) {
      this.log(`[SP3 reporting] activePower uint16 configure failed (${err.message})`);
    }

    try {
      await endpoint.clusters.metering.configureReporting({
        currentSummationDelivered:
          REDUCED_REPORTING.currentSummationDelivered,
      });
      this.log(
        `[SP3 reporting] metering configure accepted: ${
          JSON.stringify(REDUCED_REPORTING.currentSummationDelivered)
        }`,
      );
    } catch (err) {
      this.log(`[SP3 reporting] metering configure failed (${err.message})`);
    }
  }
}

module.exports = SmartPlug3Device;
