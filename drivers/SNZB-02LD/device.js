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
                    minChange: 50
                }
            ]).then(() => {
                this.log('registered attr report listener');
            }).catch(err => {
                this.error('failed to register attr report listener', err);
            });
        }

        // measure_temperature only — device has no humidity cluster
        zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
            .on('attr.measuredValue', this.onTemperatureMeasuredAttributeReport.bind(this));

        this.log('SNZB-02LD initialized');
    }

    onTemperatureMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('temperature');
        const temperatureOffset = this.getSetting('temperature_offset') || 0;
        const parsedValue = this.getSetting('temperature_decimals') === '2'
            ? Math.round((measuredValue / 100) * 100) / 100
            : Math.round((measuredValue / 100) * 10) / 10;
        this.setCapabilityValue('measure_temperature', parsedValue + temperatureOffset).catch(this.error);
    }

    async onDeleted() {
        this.log('SNZB-02LD removed');
        await this._availability?.uninstall().catch(() => {});
    }

}

module.exports = SonoffSNZB02LD;
