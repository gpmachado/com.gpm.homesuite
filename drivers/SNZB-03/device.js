'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const { CLUSTER } = require('zigbee-clusters');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { BATTERY_DEVICE_HEARTBEAT_MS } = require('../../lib/constants');

class SonoffSNZB03 extends SonoffBase {

    async onNodeInit({ zclNode }) {

        await super.onNodeInit({ zclNode });

        // Availability tracking (battery device — callback-driven via motion notifications)
        this._availability = new AvailabilityManagerCluster6(this, { timeout: BATTERY_DEVICE_HEARTBEAT_MS });
        await this._availability.install();

        // Fix upgrade from older versions that used alarm_contact
        if (this.hasCapability('alarm_contact') === true) {
            await this.removeCapability('alarm_contact');
            await this.addCapability('alarm_motion');
        }

        this.zoneStatusChangeNotification = this.zoneStatusChangeNotification.bind(this);

        // Configure battery reporting every init so Homey registers the routing
        // and re-sends the ZCL command when the device next wakes up.
        // Intervals match zigbee2mqtt ewelinkBattery() — min 3600/max 7200 prevents disconnect
        // https://github.com/Koenkk/zigbee2mqtt/issues/13600#issuecomment-1283827935
        this.configureAttributeReporting([
            {
                endpointId: 1,
                cluster: CLUSTER.POWER_CONFIGURATION,
                attributeName: 'batteryPercentageRemaining',
                minInterval: 3600,
                maxInterval: 7200,
                minChange: 2,
            },
            {
                endpointId: 1,
                cluster: CLUSTER.POWER_CONFIGURATION,
                attributeName: 'batteryVoltage',
                minInterval: 3600,
                maxInterval: 7200,
                minChange: 100,
            },
        ]).catch(err => this.error('Failed to configure battery reporting', err));

        // Read current zone status on first init (interview)
        this.initAttribute(CLUSTER.IAS_ZONE, 'zoneStatus', this.zoneStatusChangeNotification);

        zclNode.endpoints[1].clusters.iasZone.onZoneStatusChangeNotification = this.zoneStatusChangeNotification;

        this.log('SNZB-03 initialized');
    }

    zoneStatusChangeNotification(data) {
        this._markAliveFromAvailability?.('motion');
        this.setCapabilityValue('alarm_motion', data.zoneStatus.alarm1).catch(this.error);
    }

    async onDeleted() {
        this.log('SNZB-03 removed');
        await this._availability?.uninstall().catch(() => {});
    }

}

module.exports = SonoffSNZB03;
