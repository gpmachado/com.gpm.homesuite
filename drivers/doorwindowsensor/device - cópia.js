'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster6 } = AvailabilityManager;
const { TEMPHUMID_CLOCK_HEARTBEAT_MS } = require('../../lib/constants');

class DoorWindowSensorDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.printNode();

    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    this._availability = new AvailabilityManagerCluster6(this, {
      timeout: TEMPHUMID_CLOCK_HEARTBEAT_MS,
    });
    await this._availability.install();

    // IAS Zone — door/window open/closed + tamper + battery low bit
    zclNode.endpoints[1].clusters[CLUSTER.IAS_ZONE.NAME].onZoneStatusChangeNotification = payload => {
      this._onZoneStatus(payload);
    };

    // PowerConfiguration — battery percentage (0–200 raw → 0–100%)
    zclNode.endpoints[1].clusters.powerConfiguration.on('attr.batteryPercentageRemaining', value => {
      this._markAliveFromAvailability?.('battery');
      this.setCapabilityValue('measure_battery', Math.round(value / 2)).catch(this.error);
    });

    if (this.isFirstInit()) {
      await this.configureAttributeReporting([{
        endpointId: 1,
        cluster: CLUSTER.POWER_CONFIGURATION,
        attributeName: 'batteryPercentageRemaining',
        minInterval: 0,
        maxInterval: 3600,
        minChange: 2, // 1% change (raw units, value/2 = %)
      }]).catch(err => this.log('Battery reporting config failed (non-fatal):', err.message));
    }
  }

  _onZoneStatus({ zoneStatus }) {
    this.log('IAS zone:', zoneStatus);
    this._markAliveFromAvailability?.('ias');
    this.setCapabilityValue('alarm_contact', zoneStatus.alarm1).catch(this.error);
    this.setCapabilityValue('alarm_battery', zoneStatus.battery).catch(this.error);
  }

  onEndDeviceAnnounce() {
    this.log('Rejoined (ZDO announce)');
    this._markAliveFromAvailability?.('rejoin');
  }

  async onUninit() {
    await this._availability?.uninstall().catch(() => {});
  }

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log('Door/Window Sensor removed');
  }

  async onBecameAvailable() {
    this.log('Device became available');
    if (super.onBecameAvailable) await super.onBecameAvailable();
  }

  async onBecameUnavailable(reason) {
    this.log(`Device became unavailable (${reason})`);
    if (super.onBecameUnavailable) await super.onBecameUnavailable(reason);
  }
}

module.exports = DoorWindowSensorDevice;
