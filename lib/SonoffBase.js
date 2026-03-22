'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { debug, CLUSTER } = require('zigbee-clusters');

if (process.env.DEBUG === "1") {
	debug(true);
}

class SonoffBase extends ZigBeeDevice {

	async onNodeInit({zclNode}, options) {
		this.log("NodeInit SonoffBase");
		options = options || {};

		if (process.env.DEBUG === "1") {
			this.enableDebug();
		}
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

	async readAttribute(cluster, attr, handler) {
		if ("NAME" in cluster)
			cluster = cluster.NAME;
		if (!attr instanceof Array) {
			attr = [ attr ];
		}
		try {
			this.log("Ask attribute", attr);
			this.zclNode.endpoints[1].clusters[cluster]
				.readAttributes(...attr)
				.then((value) => {			
					this.log("Got attr", attr, value);
					handler(value);
				})
				.catch((e) => {			
					this.error("Error read attr", attr);
				});
		} catch (error) {
			this.error('Error (2) read', attr, error);
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