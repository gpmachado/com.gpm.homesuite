'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const { CLUSTER } = require('zigbee-clusters');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { BATTERY_DEVICE_HEARTBEAT_MS } = require('../../lib/constants');

class SonoffSNZB02LD extends SonoffBase {

    async onNodeInit({ zclNode }) {

        super.onNodeInit(...arguments);

        // Availability tracking (battery device — callback-driven via temperature reports)
        this._availability = new AvailabilityManagerCluster6(this, { timeout: BATTERY_DEVICE_HEARTBEAT_MS });
        await this._availability.install();

        if (this.isFirstInit()) {
            await this.configureAttributeReporting([
                {
                    endpointId: 1,
                    cluster: CLUSTER.TEMPERATURE_MEASUREMENT,
                    attributeName: 'measuredValue',
                    minInterval: 5,
                    maxInterval: 3600,
                    minChange: 50  // 0.5 °C in ZCL units (×100)
                },
                // Battery: aligned with Poll Control Check-In interval (1740 s ≈ 29 min, sniffer-confirmed)
                {
                    endpointId: 1,
                    cluster: CLUSTER.POWER_CONFIGURATION,
                    attributeName: 'batteryPercentageRemaining',
                    minInterval: 1620,
                    maxInterval: 1740
                },
            ])
                .then(() => this.log('registered attr report listener'))
                .catch(err => this.error('failed to register attr report listener', err));
        }

        // measure_temperature only — device has no humidity cluster.
        // Keep one stable bound reference so the listener can be removed on
        // teardown; remove-then-add guards against duplicate accumulation if
        // onNodeInit runs again on a reused cluster object.
        this._onTempReport ??= this.onTemperatureMeasuredAttributeReport.bind(this);
        const tempCluster = zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME];
        tempCluster.removeListener('attr.measuredValue', this._onTempReport);
        tempCluster.on('attr.measuredValue', this._onTempReport);

        this.log('SNZB-02LD initialized');
    }

    onTemperatureMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('temperature');
        this.setCapabilityValue('measure_temperature', Math.round(measuredValue / 10) / 10).catch(this.error);
    }

    // Remove the temperature listener on both re-init and removal so it never accumulates.
    async _teardown() {
        this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
            ?.removeListener('attr.measuredValue', this._onTempReport);
        await super._teardown();
    }

    async onDeleted() {
        await this._teardown();
        this.log('SNZB-02LD removed');
    }

}

module.exports = SonoffSNZB02LD;
