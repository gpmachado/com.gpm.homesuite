'use strict';

/**
 * Variant driver for the TS011F / _TZ3210_fgwhjm9j smart plug.
 *
 * This device reports electrical measurements much more frequently than the
 * _TZ3000_okaz9tjs variant, so it configures reduced reporting intervals on
 * top of the shared SmartPlugBase behaviour.
 */

const SmartPlugBase = require('../../lib/SmartPlugBase');

const REDUCED_REPORTING = {
  activePower: { minInterval: 30, maxInterval: 300, minChange: 5 },
  rmsCurrent: { minInterval: 30, maxInterval: 300, minChange: 50 },
  rmsVoltage: { minInterval: 60, maxInterval: 600, minChange: 2 },
  currentSummationDelivered: {
    minInterval: 60,
    maxInterval: 900,
    minChange: 1,
  },
};

class SmartPlug2Device extends SmartPlugBase {

  get diagnosticTag() {
    return 'SP2';
  }

  /**
   * Keep the standard on/off reporting and replace only this variant's noisy
   * electrical reporting.
   */
  async _safeSetupAttributeReporting() {
    await super._safeSetupAttributeReporting();

    const endpoint = this.zclNode.endpoints[1];

    try {
      await endpoint.clusters.electricalMeasurement.configureReporting({
        activePower: REDUCED_REPORTING.activePower,
        rmsCurrent: REDUCED_REPORTING.rmsCurrent,
        rmsVoltage: REDUCED_REPORTING.rmsVoltage,
      });
      this.log(
        `[${this.diagnosticTag} reporting] electricalMeasurement configure accepted: `
        + JSON.stringify({
          activePower: REDUCED_REPORTING.activePower,
          rmsCurrent: REDUCED_REPORTING.rmsCurrent,
          rmsVoltage: REDUCED_REPORTING.rmsVoltage,
        }),
      );
    } catch (err) {
      this.log(
        `[${this.diagnosticTag} reporting] electricalMeasurement configure failed (${err.message})`,
      );
    }

    try {
      await endpoint.clusters.metering.configureReporting({
        currentSummationDelivered:
          REDUCED_REPORTING.currentSummationDelivered,
      });
      this.log(
        `[${this.diagnosticTag} reporting] metering configure accepted: `
        + JSON.stringify({
          currentSummationDelivered:
            REDUCED_REPORTING.currentSummationDelivered,
        }),
      );
    } catch (err) {
      this.log(`[${this.diagnosticTag} reporting] metering configure failed (${err.message})`);
    }
  }
}

module.exports = SmartPlug2Device;
