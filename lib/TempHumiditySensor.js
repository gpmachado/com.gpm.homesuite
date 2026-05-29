'use strict';

const SonoffBase = require('./SonoffBase');
const { CLUSTER } = require('zigbee-clusters');

class TempHumiditySensor extends SonoffBase {

	async onNodeInit({zclNode}) {

		super.onNodeInit(...arguments);
		
		if (this.isFirstInit()) {

			await this.configureAttributeReporting([
				{
					endpointId: 1,
					cluster: CLUSTER.TEMPERATURE_MEASUREMENT,
					attributeName: 'measuredValue',
					minInterval: 0,
					maxInterval: 90,
					minChange: 1
				},
				{
					endpointId: 1,
					cluster: CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT,
					attributeName: 'measuredValue',
					minInterval: 0,
					maxInterval: 90,
					minChange: 1
				}
			]).then(() => {
                this.log('registered attr report listener');
            })
            .catch(err => {
                this.error('failed to register attr report listener', err);
            });
		}
		
		// Keep stable bound references so listeners can be removed on teardown;
		// remove-then-add guards against duplicate accumulation if onNodeInit
		// runs again on a reused cluster object.
		this._onTempReport ??= this.onTemperatureMeasuredAttributeReport.bind(this);
		this._onHumidityReport ??= this.onRelativeHumidityMeasuredAttributeReport.bind(this);

		// measure_temperature
		const tempCluster = zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME];
		tempCluster.removeListener('attr.measuredValue', this._onTempReport);
		tempCluster.on('attr.measuredValue', this._onTempReport);

		// measure_humidity
		const humidityCluster = zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME];
		humidityCluster.removeListener('attr.measuredValue', this._onHumidityReport);
		humidityCluster.on('attr.measuredValue', this._onHumidityReport);

	}

	// Remove sensor listeners on both re-init (onUninit) and removal (onDeleted)
	// so they never accumulate. Chains to SonoffBase._teardown for availability.
	async _teardown() {
		this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
			?.removeListener('attr.measuredValue', this._onTempReport);
		this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME]
			?.removeListener('attr.measuredValue', this._onHumidityReport);
		await super._teardown();
	}

	onTemperatureMeasuredAttributeReport(measuredValue) {
		const temperatureOffset = this.getSetting('temperature_offset') || 0;
		const parsedValue = this.getSetting('temperature_decimals') === '2' ? Math.round((measuredValue / 100) * 100) / 100 : Math.round((measuredValue / 100) * 10) / 10;
		this.setCapabilityValue('measure_temperature', parsedValue + temperatureOffset).catch(this.error);
		//this.checkBattery();
	}

	onRelativeHumidityMeasuredAttributeReport(measuredValue) {
		const humidityOffset = this.getSetting('humidity_offset') || 0;
		const parsedValue = this.getSetting('humidity_decimals') === '2' ? Math.round((measuredValue / 100) * 100) / 100 : Math.round((measuredValue / 100) * 10) / 10;
		this.setCapabilityValue('measure_humidity', parsedValue + humidityOffset).catch(this.error);
		//this.checkBattery();
	}

}

module.exports = TempHumiditySensor;