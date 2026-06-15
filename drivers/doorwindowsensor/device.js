'use strict';

/**
 * @file device.js
 * @description Tuya TS0203 Door & Window Sensor.
 * Manufacturers: _TZ3000_7tbsruql, _TZ3000_osu834un, _TZ3000_6zvw8ham
 * Protocol: ZCL IAS Zone (cluster 0x0500), battery-powered (CR2032).
 * Zone type: contactSwitch.
 *
 * IAS Zone zoneStatus bitmap (ZCL spec 8.2.2.2.1.6):
 *   Bit 0 (0x0001) alarm1   -> alarm_contact (open = true)
 *   Bit 3 (0x0008) battery  -> alarm_battery (low battery = true)
 *
 * Availability: AvailabilityManagerCluster6 (callback-driven, 4 h timeout).
 * _markAliveFromAvailability() is called on:
 *   - every IAS Zone status change notification
 *   - every battery percentage attribute report
 *   - onEndDeviceAnnounce (device rejoin)
 *
 * Battery reporting is configured with minChange=0 so the device reports
 * periodically (up to maxInterval) regardless of battery level change.
 * This periodic report acts as a heartbeat confirming the device is reachable
 * even when the door has not been opened for an extended period.
 *
 * Enrollment:
 *   zoneEnrollResponse sent on every init.
 *   onZoneEnrollRequest handles re-enrollment after factory reset.
 *   Without a valid enroll response, some TS0203 units stop sending
 *   zoneStatusChangeNotification entirely — causing silent false-unavailable.
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { APP_VERSION, BATTERY_DEVICE_HEARTBEAT_MS } = require('../../lib/constants');

// ─────────────────────────────────────────────────────────────────────────────

const DRIVER_NAME  = 'Door & Window Sensor';
const ENDPOINT_ID  = 1;
const IAS_ZONE_ID  = 1;

// IAS zoneStatus bitmask positions (ZCL spec 8.2.2.2.1.6)
const IAS_BIT_ALARM1   = 0x0001; // door/window open
const IAS_BIT_BATTERY  = 0x0008; // low battery

// Battery reporting: report every hour regardless of level change.
// minChange=0 forces periodic reports even in stable conditions — this is
// the only heartbeat available when the door is not opened for days.
const BATTERY_REPORT_MAX_INTERVAL_S = 3600; // 1 h
const BATTERY_REPORT_MIN_INTERVAL_S = 3600; // equal to max → periodic, not event-driven

// ─────────────────────────────────────────────────────────────────────────────

class DoorWindowSensorDevice extends ZigBeeDevice {

  // ─── Init ──────────────────────────────────────────────────────────────

  /**
   * @param {object} params
   * @param {import('zigbee-clusters').ZCLNode} params.zclNode
   */
  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${APP_VERSION} - init`);
    this.printNode();

    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability')
        .catch(err => this.error('addCapability is_availability:', err));

    this._availability = new AvailabilityManagerCluster6(this, {
      timeout: BATTERY_DEVICE_HEARTBEAT_MS,
    });
    await this._availability.install();

    await this._setupIASZone(zclNode);
    this._setupBatteryReporting(zclNode);

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // ─── IAS Zone ──────────────────────────────────────────────────────────

  /**
   * Configure IAS Zone cluster: enroll, listen for status changes.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  async _setupIASZone(zclNode) {
    const iasZone = zclNode.endpoints[ENDPOINT_ID].clusters[CLUSTER.IAS_ZONE.NAME];
    if (!iasZone) {
      this.error('[IAS] Cluster missing on endpoint 1');
      return;
    }

    iasZone.onZoneStatusChangeNotification = ({ zoneStatus }) => {
      this._markAliveFromAvailability?.('ias');
      this.log('[IAS] Status change — raw:', zoneStatus);
      this._applyZoneStatus(zoneStatus);
    };

    // Re-enrollment after factory reset
    iasZone.onZoneEnrollRequest = () => {
      this.log('[IAS] Enroll request — post-reset');
      this._sendEnrollResponse(iasZone);
    };

    // Read initial state on every boot so capabilities reflect reality
    // even if the door state changed while the app was off.
    try {
      const attrs = await iasZone.readAttributes(['zoneState', 'zoneStatus', 'zoneId']);
      this.log(`[IAS] zoneState=${attrs.zoneState} zoneId=${attrs.zoneId}`);
      if (attrs.zoneStatus !== undefined) {
        this._applyZoneStatus(attrs.zoneStatus);
      }
    } catch (err) {
      this.log('[IAS] Could not read initial attributes (non-fatal):', err.message);
    }

    await this._sendEnrollResponse(iasZone);
  }

  /**
   * Send ZCL zoneEnrollResponse to the device.
   * Must be sent on every init — some TS0203 units stop reporting
   * if no enroll response is received after a coordinator restart.
   * @param {object} iasZone
   */
  async _sendEnrollResponse(iasZone) {
    try {
      await iasZone.zoneEnrollResponse({ enrollResponseCode: 0x00, zoneId: IAS_ZONE_ID });
      this.log(`[IAS] Enroll response sent (zoneId=${IAS_ZONE_ID})`);
    } catch (err) {
      this.error('[IAS] Enroll response failed:', err.message);
    }
  }

  // ─── Battery ───────────────────────────────────────────────────────────

  /**
   * Listen for battery percentage reports and configure periodic reporting.
   * minChange=0 + minInterval=maxInterval forces a report every hour even
   * when battery level is stable — acts as a heartbeat for the watchdog.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  _setupBatteryReporting(zclNode) {
    zclNode.endpoints[ENDPOINT_ID].clusters.powerConfiguration
      .on('attr.batteryPercentageRemaining', value => {
        this._markAliveFromAvailability?.('battery');
        this.setCapabilityValue('measure_battery', Math.round(value / 2))
          .catch(this.error);
      });

    if (this.isFirstInit()) {
      this.configureAttributeReporting([{
        endpointId:    ENDPOINT_ID,
        cluster:       CLUSTER.POWER_CONFIGURATION,
        attributeName: 'batteryPercentageRemaining',
        minInterval:   BATTERY_REPORT_MIN_INTERVAL_S,
        maxInterval:   BATTERY_REPORT_MAX_INTERVAL_S,
        minChange:     0,
      }]).catch(err => this.log('Battery reporting config failed (non-fatal):', err.message));
    }
  }

  // ─── Zone status ───────────────────────────────────────────────────────

  /**
   * Parse IAS zoneStatus bitmap and update capabilities.
   * @param {number|Buffer|object} zoneStatus
   */
  _applyZoneStatus(zoneStatus) {
    const bitmap = this._toUint16(zoneStatus);
    const open       = !!(bitmap & IAS_BIT_ALARM1);
    const batteryLow = !!(bitmap & IAS_BIT_BATTERY);

    this.log(`[IAS] open=${open} batteryLow=${batteryLow} (0x${bitmap.toString(16).padStart(4, '0')})`);

    this._setCapSafe('alarm_contact', open);
    this._setCapSafe('alarm_battery', batteryLow);
  }

  // ─── Availability ──────────────────────────────────────────────────────

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._markAliveFromAvailability?.('rejoin');
  }

  async onBecameAvailable() {
    this.log('Device became available');
  }

  async onBecameUnavailable(reason) {
    this.log(`Device became unavailable (${reason})`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Normalise zoneStatus to a uint16 number.
   * Handles: Buffer, Buffer-like {type:'Buffer',data:[]}, number, named-key object.
   * @param {number|Buffer|object} value
   * @returns {number}
   */
  _toUint16(value) {
    if (Buffer.isBuffer(value)) return value.readUInt16LE(0);
    if (value?.type === 'Buffer' && Array.isArray(value.data))
      return Buffer.from(value.data).readUInt16LE(0);
    if (typeof value === 'number') return value;
    const bits = {
      alarm1: IAS_BIT_ALARM1, alarm2: 0x0002, tamper: 0x0004,
      battery: IAS_BIT_BATTERY, acMains: 0x0010, test: 0x0020,
      batteryDefect: 0x0040,
    };
    return Object.entries(bits).reduce(
      (acc, [k, mask]) => value[k] ? acc | mask : acc, 0
    );
  }

  /**
   * Set capability only when value changes; silently skip missing capabilities.
   * @param {string} capability
   * @param {*} value
   */
  _setCapSafe(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value)
      .catch(err => this.error(`Failed to set ${capability}:`, err.message));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async onUninit() {
    await this._availability?.uninstall().catch(() => {});
  }

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }

}

module.exports = DoorWindowSensorDevice;