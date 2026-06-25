'use strict';

/**
 * @file device.js
 * @description Tuya TS0203 Door & Window Sensor, 2x AAA variant.
 * Manufacturers: _TZ3000_6zvw8ham
 * Protocol: ZCL IAS Zone (cluster 0x0500), battery-powered (2x AAA).
 * Zone type: contactSwitch.
 *
 * IAS Zone zoneStatus bitmap (ZCL spec 8.2.2.2.1.6):
 *   Bit 0 (0x0001) alarm1   -> alarm_contact (open = true)
 *   Bit 3 (0x0008) battery  -> alarm_battery (low battery = true)
 *
 * Availability: AvailabilityManagerCluster0 (passive handleFrame hook, 15 min test timeout).
 * Any inbound Zigbee frame counts as activity, including:
 *   - Basic cluster reports (0x0000)
 *   - Identify cluster frames (0x0003)
 *   - IAS Zone status change notifications (0x0500)
 *   - battery percentage reports (Power Configuration 0x0001)
 *
 * Battery reporting is configured with minChange=1 so the device reports
 * periodically (up to maxInterval) and on small battery-level changes.
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
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { APP_VERSION, DOOR_SENSOR_HEARTBEAT_MS } = require('../../lib/constants');

// ─────────────────────────────────────────────────────────────────────────────

const DRIVER_NAME  = 'Door & Window Sensor';
const ENDPOINT_ID  = 1;
const IAS_ZONE_ID  = 1;

// IAS zoneStatus bitmask positions (ZCL spec 8.2.2.2.1.6)
const IAS_BIT_ALARM1   = 0x0001; // door/window open
const IAS_BIT_BATTERY  = 0x0008; // low battery

// Battery reporting: keep a gentle periodic report and report on 1 raw-unit change.
// TS0203 availability is tracked from any inbound frame, not only battery reports.
const BATTERY_REPORT_MAX_INTERVAL_S = 14400; // 4 h
const BATTERY_REPORT_MIN_INTERVAL_S = 3600;  // 1 h
const BATTERY_REPORT_MIN_CHANGE = 1;

// ─────────────────────────────────────────────────────────────────────────────

class DoorWindowSensorDevice2 extends ZigBeeDevice {

  // ─── Init ──────────────────────────────────────────────────────────────

  /**
   * @param {object} params
   * @param {import('zigbee-clusters').ZCLNode} params.zclNode
   */
  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${APP_VERSION} - init`);
    this.printNode();
    this._zclNode = zclNode;
    this._batteryReportingConfigured = false;
    this._batteryReportingConfiguring = false;
    this._lastBatteryReportingAttemptTs = 0;

    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability')
        .catch(err => this.error('addCapability is_availability:', err));

    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: DOOR_SENSOR_HEARTBEAT_MS,
      resetLastSeenOnInstall: true,
    });
    await this._availability.install();

    await this._setupIASZone(zclNode);
    await this._setupBatteryReporting(zclNode);

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // ─── IAS Zone ──────────────────────────────────────────────────────────

  /**
   * Configure IAS Zone cluster: enroll, listen for status changes, write CIE Address.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  async _setupIASZone(zclNode) {
    const iasZone = zclNode.endpoints[ENDPOINT_ID].clusters[CLUSTER.IAS_ZONE.NAME];
    if (!iasZone) {
      this.error('[IAS] Cluster missing on endpoint 1');
      return;
    }

    // Set synchronous enroll request listener BEFORE sending response
    iasZone.onZoneEnrollRequest = () => {
      this.log('[IAS] Zone Enroll Request received (synchronous callback)');
      iasZone.zoneEnrollResponse({ enrollResponseCode: 0, zoneId: IAS_ZONE_ID })
        .then(() => {
          this.log(`[IAS] Synchronous Enrollment Response sent (zoneId=${IAS_ZONE_ID})`);
          this._iasEnrolled = true;
        })
        .catch(err => this.error('[IAS] Synchronous Enrollment Response failed:', err.message));
    };

    iasZone.onZoneStatusChangeNotification = ({ zoneStatus }) => {
      this._notifyAvailability('ias');
      this._retryBatteryReportingOnWake('ias');
      this.log('[IAS] Status change — raw:', zoneStatus);
      this._applyZoneStatus(zoneStatus);
    };

    // Also listen to attribute reports (fallback for some devices)
    iasZone.on('attr.zoneStatus', (zoneStatus) => {
      this._notifyAvailability('ias-attr');
      this.log('[IAS] attr.zoneStatus report received:', zoneStatus);
      this._applyZoneStatus(zoneStatus);
    });

    // Run enrollment flow asynchronously so we don't block node initialization
    this._runEnrollmentFlow(iasZone).catch(err => {
      this.error('[IAS] Enrollment flow error:', err.message);
    });
  }

  /**
   * Run the full enrollment flow: wait for stack, read status, write/verify CIE, and send response.
   * For end-devices, defer operations to when device wakes up.
   * @param {object} iasZone
   */
  async _runEnrollmentFlow(iasZone) {
    this.log('[IAS] Starting enrollment flow (deferred for end-device)...');
    
    // For end-devices, mark as pending and wait for wake
    this._enrollmentPending = true;
    this.log('[IAS] Enrollment deferred - will retry when device wakes up');
  }

  /**
   * Retry enrollment when device wakes up.
   */
  async _retryEnrollmentOnWake() {
    if (!this._enrollmentPending || !this._zclNode) return;
    
    const iasZone = this._zclNode.endpoints[ENDPOINT_ID]?.clusters?.[CLUSTER.IAS_ZONE.NAME];
    if (!iasZone) return;

    this.log('[IAS] Retrying enrollment on wake...');
    
    // 1. Try to read initial state
    try {
      const attrs = await iasZone.readAttributes(['zoneState', 'zoneStatus', 'zoneId']);
      this._notifyAvailability('ias-read-wake');
      this.log(`[IAS] Read attributes on wake: zoneState=${attrs.zoneState} zoneId=${attrs.zoneId}`);
      if (attrs.zoneStatus !== undefined) {
        this._applyZoneStatus(attrs.zoneStatus);
      }
      if (attrs.zoneState === 'enrolled' || attrs.zoneState === 1) {
        this.log('[IAS] Device is already enrolled');
        this._enrollmentPending = false;
        return;
      }
    } catch (err) {
      this.log('[IAS] Could not read on wake (will retry):', err.message);
      return;
    }

    // 2. Try to write CIE Address
    const coordIeee = await this._getCoordinatorIeee();
    if (coordIeee) {
      const cieVerified = await this._writeAndVerifyCie(iasZone, coordIeee);
      if (cieVerified) {
        this.log('[IAS] CIE Address successfully set and verified on wake');
      } else {
        this.log('[IAS] CIE Address write could not be verified (will retry)');
        return;
      }
    } else {
      this.log('[IAS] Could not retrieve Coordinator IEEE');
      return;
    }

    // 3. Send enrollment response
    try {
      await iasZone.zoneEnrollResponse({ enrollResponseCode: 0, zoneId: IAS_ZONE_ID });
      this.log(`[IAS] Enrollment Response sent on wake (zoneId=${IAS_ZONE_ID})`);
      this._enrollmentPending = false;
    } catch (err) {
      this.log('[IAS] Enrollment Response failed on wake (will retry):', err.message);
    }
  }

  /**
   * Retrieve the Homey coordinator IEEE Address using dynamic fallbacks.
   * @returns {Promise<string|null>}
   */
  async _getCoordinatorIeee() {
    const methods = [
      () => this.homey?.zigbee?.ieeeAddress,
      () => this.homey?.zigbee?.address,
      () => this.driver?.homey?.zigbee?.address,
      () => this.driver?.homey?.zigbee?.ieeeAddress,
      () => this._zclNode?.networkAddress?.coordinatorIeee,
      async () => {
        if (this.homey?.zigbee?.getIeeeAddress) {
          try { return await this.homey.zigbee.getIeeeAddress(); } catch (e) { return null; }
        }
        return null;
      },
      async () => {
        if (this.homey?.zigbee?.getNetwork) {
          try {
            const network = await this.homey.zigbee.getNetwork();
            return network?.coordinatorIeeeAddress || network?.ieeeAddress;
          } catch (e) { return null; }
        }
        return null;
      }
    ];

    for (const method of methods) {
      try {
        const res = await Promise.resolve(method());
        if (res && typeof res === 'string') {
          const clean = res.replace(/[:\-\s]/g, '').replace(/^0x/i, '').toLowerCase();
          if (clean.length === 16 && !/^0+$/.test(clean)) {
            // Format to standard colon-separated representation
            return clean.match(/.{2}/g).join(':');
          }
        }
      } catch (err) {
        // skip
      }
    }
    return null;
  }

  /**
   * Write and verify the coordinator IEEE address to the device iasCIEAddress attribute.
   * @param {object} iasZone
   * @param {string} coordIeee
   * @returns {Promise<boolean>}
   */
  async _writeAndVerifyCie(iasZone, coordIeee) {
    const attrNames = ['iasCIEAddress', 'iasCieAddress', 'iasCieAddr'];
    for (const attrName of attrNames) {
      try {
        this.log(`[IAS] Writing CIE Address (${coordIeee}) to attribute ${attrName}...`);
        await iasZone.writeAttributes({ [attrName]: coordIeee });
        this.log(`[IAS] CIE Address written successfully to ${attrName}`);
        
        // Read back to verify
        await new Promise(r => this.homey.setTimeout(r, 1000));
        const readAttrs = await iasZone.readAttributes([attrName]).catch(() => null);
        if (readAttrs && readAttrs[attrName]) {
          const readVal = String(readAttrs[attrName]).replace(/[:\-\s]/g, '').replace(/^0x/i, '').toLowerCase();
          const expectedVal = coordIeee.replace(/[:\-\s]/g, '').replace(/^0x/i, '').toLowerCase();
          if (readVal === expectedVal) {
            this.log(`[IAS] CIE Address verified successfully on ${attrName}: ${readAttrs[attrName]}`);
            return true;
          } else {
            this.log(`[IAS] CIE Address verification mismatch on ${attrName}: expected ${expectedVal}, got ${readVal}`);
          }
        }
      } catch (err) {
        this.log(`[IAS] Failed writing to attribute ${attrName}:`, err.message);
      }
    }
    return false;
  }

  // ─── Battery ───────────────────────────────────────────────────────────

  /**
   * Listen for battery percentage reports and configure periodic reporting.
   * minChange=1 keeps the reporting gentle while still giving us a periodic
   * heartbeat when the device accepts the configuration.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  async _setupBatteryReporting(zclNode) {
    const powerConfiguration = zclNode.endpoints[ENDPOINT_ID].clusters.powerConfiguration;
    this._absorbLateGlobalResponses(powerConfiguration);

    powerConfiguration.on('attr.batteryPercentageRemaining', value => {
      this._applyBatteryPercentage(value, 'battery');
    });

    if (!this.isFirstInit()) {
      this.log('[Battery] Initial read/reporting deferred until wake');
      return;
    }

    try {
      const attrs = await powerConfiguration.readAttributes(['batteryPercentageRemaining']);
      if (attrs.batteryPercentageRemaining !== undefined) {
        this._applyBatteryPercentage(attrs.batteryPercentageRemaining, 'battery-read');
      }
    } catch (err) {
      this.log('[Battery] Could not read initial battery percentage (non-fatal):', err.message);
    }

    await this._configureBatteryReporting('init');
  }

  /**
   * Configure periodic battery reporting. Sleepy TS0203 devices often reject
   * this at app boot because they are already asleep, so IAS wakeups retry it.
   * @param {string} source
   */
  async _configureBatteryReporting(source) {
    if (this._batteryReportingConfigured || this._batteryReportingConfiguring) return;

    this._batteryReportingConfiguring = true;
    this._lastBatteryReportingAttemptTs = Date.now();
    try {
      await this.configureAttributeReporting([{
        endpointId:    ENDPOINT_ID,
        cluster:       CLUSTER.POWER_CONFIGURATION,
        attributeName: 'batteryPercentageRemaining',
        minInterval:   BATTERY_REPORT_MIN_INTERVAL_S,
        maxInterval:   BATTERY_REPORT_MAX_INTERVAL_S,
        minChange:     BATTERY_REPORT_MIN_CHANGE,
      }]);
      this._batteryReportingConfigured = true;
      this.log(`[Battery] Reporting configured (${source})`);
    } catch (err) {
      this.log(`Battery reporting config failed (${source}, non-fatal):`, err.message);
    } finally {
      this._batteryReportingConfiguring = false;
    }
  }

  // ─── Zone status ───────────────────────────────────────────────────────

  /**
   * Parse IAS zoneStatus bitmap and update capabilities.
   * Evaluates alarm1 and alarm2 (dual-bit check) to ensure compatibility.
   * @param {number|Buffer|object} zoneStatus
   */
  _applyZoneStatus(zoneStatus) {
    const bitmap = this._toUint16(zoneStatus);
    const alarm1 = !!(bitmap & IAS_BIT_ALARM1);
    const open = alarm1;
    const batteryLow = !!(bitmap & IAS_BIT_BATTERY);

    this.log(`[IAS] contact=${open} batteryLow=${batteryLow} (zoneStatus=0x${bitmap.toString(16).padStart(4, '0')})`);

    this._setCapSafe('alarm_contact', open);
    this._setCapSafe('alarm_battery', batteryLow);
  }

  // ─── Availability ──────────────────────────────────────────────────────

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._notifyAvailability('rejoin');
    // Retry enrollment and battery operations when device wakes up
    this._retryEnrollmentOnWake();
    this._retryBatteryReportingOnWake('end-device-announce');
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

  /**
   * Convert ZCL batteryPercentageRemaining (0-200) to Homey percent (0-100).
   * @param {number} value
   * @param {string} source
   */
  _applyBatteryPercentage(value, source) {
    if (typeof value !== 'number') return;
    const percentage = Math.max(0, Math.min(100, Math.round(value / 2)));
    this._notifyAvailability(source);
    this.log(`[Battery] ${percentage}% (raw=${value})`);
    this._setCapSafe('measure_battery', percentage);
  }

  /**
   * Explicit activity marker for events that may not pass through handleFrame.
   * @param {string} source
   */
  _notifyAvailability(source) {
    this._availability?.notifyActivity?.(source).catch(() => {});
  }

  /**
   * Retry battery reporting when the sensor is known to be awake.
   * @param {string} source
   */
  _retryBatteryReportingOnWake(source) {
    if (this._batteryReportingConfigured || !this._zclNode) return;
    const now = Date.now();
    if ((now - this._lastBatteryReportingAttemptTs) < 60_000) return;
    this._configureBatteryReporting(`${source}-wake`).catch(err => {
      this.log(`Battery reporting retry failed (${source}, non-fatal):`, err.message);
    });
  }

  /**
   * Some sleepy TS0203 devices repeat global responses after the transaction
   * handler has already resolved or timed out. Absorb those late responses so
   * zigbee-clusters does not log unknown_command_received for successful battery
   * reads/reporting configuration.
   * @param {object} cluster
   */
  _absorbLateGlobalResponses(cluster) {
    if (!cluster || cluster._homeSuiteLateResponseHandlers) return;
    cluster._homeSuiteLateResponseHandlers = true;

    const noop = () => {};
    cluster['onReadAttributes.response'] = noop;
    cluster['onReadAttributesStructured.response'] = noop;
    cluster['onConfigureReporting.response'] = noop;
    cluster.onDefaultResponse = noop;
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

module.exports = DoorWindowSensorDevice2;
