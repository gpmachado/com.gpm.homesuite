'use strict';

const TempHumiditySensor = require('../../lib/TempHumiditySensor');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { BATTERY_DEVICE_HEARTBEAT_MS } = require('../../lib/constants');

class SonoffSNZB02WD extends TempHumiditySensor {

    async onNodeInit({ zclNode }) {
        await super.onNodeInit({ zclNode });

        // Availability tracking (battery device — callback-driven via temperature/humidity reports)
        this._availability = new AvailabilityManagerCluster6(this, { timeout: BATTERY_DEVICE_HEARTBEAT_MS });
        await this._availability.install();

        this.log('SNZB-02WD initialized');
    }

    // Override to signal alive on each temperature report
    onTemperatureMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('temperature');
        super.onTemperatureMeasuredAttributeReport(measuredValue);
    }

    // Override to signal alive on each humidity report
    onRelativeHumidityMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('humidity');
        super.onRelativeHumidityMeasuredAttributeReport(measuredValue);
    }

    async onDeleted() {
        this.log('SNZB-02WD removed');
        await this._availability?.uninstall().catch(() => {});
    }

}

module.exports = SonoffSNZB02WD;
