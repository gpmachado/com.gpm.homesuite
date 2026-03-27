'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

class SonoffBase extends ZigBeeDevice {

	async onNodeInit({zclNode}, options) {
		this.log(`NodeInit SonoffBase: ${this.getName()}`);
		options = options || {};
		this.printNode();

		if (options.noAttribCheck !== true) {
			if ("powerConfiguration" in zclNode.endpoints[1].clusters) {
				// Battery-powered devices report proactively — listen and update capability.
				this.zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME]
					.on('attr.batteryPercentageRemaining', (value) => {
						this.log(`[Battery] ${value / 2}%`);
						this.setCapabilityValue('measure_battery', value / 2).catch(this.error);
					});
			}
		}
	}

	async initAttribute(cluster, attr, handler) {
		if (!this.isFirstInit())
			return;
		this.readAttribute(cluster, attr, handler)
    }

	async readAttribute(cluster, attr, handler, maxRetries = 3, baseDelay = 3000) {
		if ("NAME" in cluster) cluster = cluster.NAME;
		if (!attr instanceof Array) attr = [attr];

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				this.log("Ask attribute", attr);
				const value = await this.zclNode.endpoints[1].clusters[cluster].readAttributes(...attr);
				this.log("Got attr", attr, value);
				handler(value);
				return;
			} catch (e) {
				if (attempt < maxRetries) {
					const delay = baseDelay * Math.pow(2, attempt) * (0.5 + Math.random()); // jitter ±50%
					this.log(`Retry read attr ${attr} in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
					await new Promise(r => this.homey.setTimeout(r, delay));
				} else {
					this.log("Device unreachable — attr read skipped:", attr);
				}
			}
		}
	}

	async writeAttribute(cluster, attr, value) {
		var data = {};
		data[attr] = value;
		this.writeAttributes(cluster, data);
	}

	async writeAttributes(cluster, attribs, filter=null) {
		let items = {};
		try {
			if ("NAME" in cluster)
				cluster = cluster.NAME;
			const clust = this.zclNode.endpoints[1].clusters[cluster];
			items = {};
			for (const key in attribs) {
				if (filter && !filter.includes(key))
					continue;
				if (!(key in clust.constructor.attributes))
					continue;
				items[key] = attribs[key];
			}

			if (!Object.keys(items).length) {
				this.log("Write attribute", {});
				return;
			}

			this.log("Write attribute", items);
			const result = await clust.writeAttributes(items);
			return result;
		} catch (error) {
			this.error("Error write attr", items, error);
			throw error;
		}
	}

	onDeleted(){
		this.log("sonoff device removed")
	}

}

module.exports = SonoffBase;