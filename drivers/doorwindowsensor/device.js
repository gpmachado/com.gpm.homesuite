'use strict';

/**
 * @file device.js
 * @description Tuya TS0203 Door & Window Sensor.
 * Manufacturers: _TZ3000_7tbsruql, _TZ3000_osu834un
 * Protocol: ZCL IAS Zone (cluster 0x0500), battery-powered (CR2032).
 * Zone type: contactSwitch.
 *
 * IAS Zone zoneStatus bitmap
 *   Bit 0 (0x0001) alarm1   -> alarm_contact (open = true)
 *   Bit 3 (0x0008) battery  -> alarm_battery (low battery = true)
 *
 * Availability: AvailabilityManagerCluster0 (passive handleFrame hook, 4 h timeout).
 * Any inbound Zigbee frame counts as activity, including:
 *   - Basic cluster reports (0x0000)
 *   - Identify cluster frames (0x0003)
 *   - IAS Zone status change notifications (0x0500)
 *   - battery percentage reports (Power Configuration 0x0001)
 *
 * Battery reporting is configured with minChange=1, but this TS0203 firmware
 * may stay silent despite accepting the reporting command. A 30 min poll reads
 * battery and zoneStatus so stable closed/open doors still produce heartbeats.
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
const IASZoneHelper = require('../../lib/IASZoneHelper');
const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');
const { APP_VERSION, DOOR_SENSOR_HEARTBEAT_MS, DOOR_SENSOR_POLL_INTERVAL_MS } = require('../../lib/constants');

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

class DoorWindowSensorDevice extends ZigBeeDevice {

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
    this._pollTimer = null;

    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability')
        .catch(err => this.error('addCapability is_availability:', err));

    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: DOOR_SENSOR_HEARTBEAT_MS,
      resetLastSeenOnInstall: true,
    });
    await this._availability.install();

    this._bindSilentTimeCluster(zclNode);
    await this._setupIASZone(zclNode);
    await this._setupBatteryReporting(zclNode);
    this._startPolling();

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // ─── IAS Zone ──────────────────────────────────────────────────────────

  /**
   * Configure IAS Zone cluster: enroll, listen for status changes, write CIE Address.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  async _setupIASZone(zclNode) {
    this._iasHelper = new IASZoneHelper(this, {
      endpointId: ENDPOINT_ID,
      zoneId: IAS_ZONE_ID,
      configureCieAddress: true,
      onActivity: source => {
        this._notifyAvailability(source);
        this._retryBatteryReportingOnWake(source);
      },
      onStatus: zoneStatus => this._applyZoneStatus(zoneStatus),
    });

    this._iasZone = await this._iasHelper.init(zclNode);
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
    if (!powerConfiguration) {
      this.log('[Battery] Power Configuration cluster missing on endpoint 1');
      return;
    }
    this._powerConfiguration = powerConfiguration;

    this._onBatteryPercentage ??= value => {
      this._applyBatteryPercentage(value, 'battery');
    };
    powerConfiguration.removeListener('attr.batteryPercentageRemaining', this._onBatteryPercentage);
    powerConfiguration.on('attr.batteryPercentageRemaining', this._onBatteryPercentage);

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

  // ─── Polling ───────────────────────────────────────────────────────────

  /**
   * Poll battery and IAS state periodically. TS0203 accepts battery reporting
   * configuration but may stay silent for hours, so successful reads are also
   * used as availability heartbeats.
   */
  _startPolling() {
    this._stopPolling();

    this._pollTimer = this.homey.setInterval(() => {
      this._pollSensorState('interval').catch(err => {
        this.log('[Poll] Failed:', err.message);
      });
    }, DOOR_SENSOR_POLL_INTERVAL_MS);

    this.log(`[Poll] Started (${Math.round(DOOR_SENSOR_POLL_INTERVAL_MS / 60000)} min)`);
  }

  _stopPolling() {
    if (!this._pollTimer) return;
    this.homey.clearInterval(this._pollTimer);
    this._pollTimer = null;
    this.log('[Poll] Stopped');
  }

  async _pollSensorState(source) {
    let sawResponse = false;

    if (this._powerConfiguration?.readAttributes) {
      try {
        const attrs = await this._powerConfiguration.readAttributes(['batteryPercentageRemaining']);
        if (attrs.batteryPercentageRemaining !== undefined) {
          sawResponse = true;
          this._applyBatteryPercentage(attrs.batteryPercentageRemaining, `poll-${source}`);
        }
      } catch (err) {
        this.log(`[Poll] Battery read failed (${source}, non-fatal):`, err.message);
      }
    }

    if (this._iasZone?.readAttributes) {
      try {
        const attrs = await this._iasZone.readAttributes(['zoneStatus']);
        if (attrs.zoneStatus !== undefined) {
          sawResponse = true;
          this._applyZoneStatus(attrs.zoneStatus);
        }
      } catch (err) {
        this.log(`[Poll] IAS read failed (${source}, non-fatal):`, err.message);
      }
    }

    if (sawResponse) this._notifyAvailability(`poll-${source}`);
  }

  // ─── Zone status ───────────────────────────────────────────────────────

  /**
   * Parse IAS zoneStatus bitmap and update capabilities.
   * Evaluates alarm1 and alarm2 (dual-bit check) to ensure compatibility.
   * @param {number|Buffer|object} zoneStatus
   */
  _applyZoneStatus(zoneStatus) {
    const bitmap = IASZoneHelper.toUint16(zoneStatus);
    const alarm1 = !!(bitmap & IAS_BIT_ALARM1);
    const alarm2 = !!(bitmap & 0x0002); // alarm2 secondary
    const open = alarm1 || alarm2;
    const batteryLow = !!(bitmap & IAS_BIT_BATTERY);

    this.log(`[IAS] open=${open} (alarm1=${alarm1}, alarm2=${alarm2}) batteryLow=${batteryLow} (0x${bitmap.toString(16).padStart(4, '0')})`);

    this._setCapSafe('alarm_contact', open);
    this._setCapSafe('alarm_battery', batteryLow);
  }

  // ─── Availability ──────────────────────────────────────────────────────

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._notifyAvailability('rejoin');
  }

  async onBecameAvailable() {
    this.log('Device became available');
  }

  async onBecameUnavailable(reason) {
    this.log(`Device became unavailable (${reason})`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

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
    this._configureBatteryReporting(`${source}-wake`).catch(err => {
      this.log(`Battery reporting retry failed (${source}, non-fatal):`, err.message);
    });
  }

  _bindSilentTimeCluster(zclNode) {
    try {
      const endpoint = zclNode.endpoints[ENDPOINT_ID];
      if (!endpoint) return;
      endpoint.bind('time', new TimeSilentBoundCluster());
      this.log('[Time] Silent bound cluster installed');
    } catch (err) {
      this.log('[Time] Silent bind skipped:', err.message);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async onUninit() {
    this._stopPolling();
    this._iasHelper?.dispose();
    this._powerConfiguration?.removeListener?.('attr.batteryPercentageRemaining', this._onBatteryPercentage);
    await this._availability?.uninstall().catch(() => {});
  }

  onDeleted() {
    this._stopPolling();
    this._iasHelper?.dispose();
    this._powerConfiguration?.removeListener?.('attr.batteryPercentageRemaining', this._onBatteryPercentage);
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }

}

module.exports = DoorWindowSensorDevice;
