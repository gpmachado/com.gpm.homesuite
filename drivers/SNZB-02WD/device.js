'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const { CLUSTER } = require('zigbee-clusters');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { BATTERY_DEVICE_HEARTBEAT_MS } = require('../../lib/constants');

class SonoffSNZB02WD extends SonoffBase {

    async onNodeInit({ zclNode }) {
        super.onNodeInit(...arguments); // SonoffBase: printNode + battery listener

        if (this.isFirstInit()) {
            await this.configureAttributeReporting([
                // minChange in ZCL units (×100): 50 = 0.5 °C, 300 = 3 %RH (iHost defaults, sniffer-confirmed)
                // maxInterval 3600 s: report at most once per hour if nothing changes (battery-friendly)
                { endpointId: 1, cluster: CLUSTER.TEMPERATURE_MEASUREMENT,    attributeName: 'measuredValue', minInterval: 5, maxInterval: 3600, minChange: 50  },
                { endpointId: 1, cluster: CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT, attributeName: 'measuredValue', minInterval: 5, maxInterval: 3600, minChange: 300 },
                // Battery: report aligned with Poll Control Check-In interval (1740 s ≈ 29 min, sniffer-confirmed)
                { endpointId: 1, cluster: CLUSTER.POWER_CONFIGURATION, attributeName: 'batteryPercentageRemaining', minInterval: 1620, maxInterval: 1740 },
            ])
                .then(() => this.log('registered attr report listener'))
                .catch(err => this.error('failed to register attr report listener', err));
        }

        // Keep stable bound references so listeners can be removed on teardown;
        // remove-then-add guards against duplicate accumulation if onNodeInit
        // runs again on a reused cluster object.
        this._onTempReport ??= this.onTemperatureMeasuredAttributeReport.bind(this);
        this._onHumidityReport ??= this.onRelativeHumidityMeasuredAttributeReport.bind(this);

        const tempCluster = zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME];
        tempCluster.removeListener('attr.measuredValue', this._onTempReport);
        tempCluster.on('attr.measuredValue', this._onTempReport);

        const humidityCluster = zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME];
        humidityCluster.removeListener('attr.measuredValue', this._onHumidityReport);
        humidityCluster.on('attr.measuredValue', this._onHumidityReport);

        // Availability tracking (battery device — callback-driven via temperature/humidity reports)
        this._availability = new AvailabilityManagerCluster6(this, { timeout: BATTERY_DEVICE_HEARTBEAT_MS });
        await this._availability.install();

        this.log('SNZB-02WD initialized');
    }

    onTemperatureMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('temperature');
        const offset = this.getSetting('temperature_offset') || 0;
        const parsed = this.getSetting('temperature_decimals') === '2'
            ? Math.round((measuredValue / 100) * 100) / 100
            : Math.round((measuredValue / 100) * 10) / 10;
        this.setCapabilityValue('measure_temperature', parsed + offset).catch(this.error);
    }

    onRelativeHumidityMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('humidity');
        const offset = this.getSetting('humidity_offset') || 0;
        const parsed = this.getSetting('humidity_decimals') === '2'
            ? Math.round((measuredValue / 100) * 100) / 100
            : Math.round((measuredValue / 100) * 10) / 10;
        this.setCapabilityValue('measure_humidity', parsed + offset).catch(this.error);
    }

    // Remove sensor listeners on both re-init (onUninit) and removal (onDeleted)
    // so they never accumulate. Chains to SonoffBase._teardown (battery + availability).
    async _teardown() {
        this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
            ?.removeListener('attr.measuredValue', this._onTempReport);
        this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME]
            ?.removeListener('attr.measuredValue', this._onHumidityReport);
        await super._teardown();
    }

    async onDeleted() {
        await this._teardown();
        this.log('SNZB-02WD removed');
    }

}

module.exports = SonoffSNZB02WD;
