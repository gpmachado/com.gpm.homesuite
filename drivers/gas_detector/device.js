'use strict';

/**
 * @file device.js
 * @description Heiman Smart Gas Detector -- TS0204 / _TYZB01_0w3d5uw3
 * Protocol : ZCL IAS Zone (cluster 0x0500), AC-powered (wall socket).
 * Zone type : carbonMonoxideSensor.
 *
 * IAS Zone zoneStatus bitmap (ZCL spec 8.2.2.2.1.6):
 *   Bit 0 (0x0001) alarm1   -> alarm_gas
 *   Bit 3 (0x0008) trouble  -> alarm_problem
 *   Bit 5 (0x0020) test     -> logged only
 *
 * Note: the test button fires alarm1 identically to real gas detection.
 * Use a native Homey Flow condition ("alarm stays ON for X seconds") to
 * filter out short test activations -- no driver-level suppression needed.
 *
 * Availability: uses AvailabilityManagerCluster6 (callback-driven) with a
 * 4-hour timeout. IAS Zone devices are silent when no alarm is active, so
 * AvailabilityManagerCluster0 (handleFrame / 5 min) would give false negatives.
 * _markAliveFromAvailability() is called on every inbound IAS report and on
 * onEndDeviceAnnounce (device rejoining the network).
 *
 * Enrollment:
 *   zoneEnrollResponse sent on every init.
 *   onZoneEnrollRequest handles re-enrollment after factory reset.
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, debug } = require('zigbee-clusters');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');

// ─────────────────────────────────────────────────────────────────────────────

// IAS Zone enroll ID assigned to this device
const IAS_ZONE_ID = 1;

const { APP_VERSION, GAS_DETECTOR_HEARTBEAT_MS } = require('../../lib/constants');

const DRIVER_NAME = 'Smart Gas Detector';
const ENDPOINT_ID = 1;

// Set true to log every inbound Zigbee frame (useful to check if device sends keepalives).
// Turn off in production to reduce log noise.
const DEBUG_FRAMES = false;

// IAS zoneStatus bitmask positions (ZCL spec 8.2.2.2.1.6)
const IAS_BIT_ALARM1 = 0x0001; // gas detected
const IAS_BIT_TROUBLE = 0x0008; // fault / trouble
const IAS_BIT_TEST = 0x0020; // test button

// ─────────────────────────────────────────────────────────────────────────────

class GasDetector extends ZigBeeDevice {

  // ─── Init ──────────────────────────────────────────────────────────────

  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${APP_VERSION} - init`);
    this.printNode();

    // Migrate existing paired devices: add is_availability if missing
    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    // Silence Tuya manufacturer-specific commands on basic cluster (0xF1 device-ident frame).
    // ZCLMfgSpecificHeader frames have a manufacturerId field; standard frames do not.
    this._origZclHandle = zclNode.handleFrame?.bind(zclNode);
    zclNode.handleFrame = (ep, cl, frame, meta) => {
      if (cl === 0 && frame?.manufacturerId !== undefined) return true;
      return this._origZclHandle ? this._origZclHandle(ep, cl, frame, meta) : false;
    };

    await this._setupIASZone(zclNode);

    // Availability: callback-driven (IAS Zone only reports on alarm, not periodically)
    this._availability = new AvailabilityManagerCluster6(this, { timeout: GAS_DETECTOR_HEARTBEAT_MS });
    await this._availability.install();

    // Optional: log every inbound Zigbee frame so we can see if the device
    // sends periodic keepalives (would allow switching to AvailabilityManagerCluster0).
    if (DEBUG_FRAMES) {
      debug(true); // enable zigbee-clusters verbose ZCL parsing logs
      this.log('[Frame] ZCL debug enabled (set DEBUG_FRAMES=false to disable)');
      await this._installFrameDebug();
    }

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // ─── Frame debug ───────────────────────────────────────────────────────

  async _installFrameDebug() {
    try {
      const node = await this.homey.zigbee.getNode(this);
      if (!node) return;
      const original = node.handleFrame?.bind(node);
      node.handleFrame = async (endpointId, clusterId, frame, meta) => {
        this.log(`[Frame] ep=${endpointId} cluster=0x${clusterId.toString(16).padStart(4, '0')} seq=${frame?.seqNum ?? '-'}`);
        return original ? original(endpointId, clusterId, frame, meta) : undefined;
      };
      this.log('[Frame] Debug hook installed');
    } catch (err) {
      this.error('[Frame] Could not install debug hook:', err.message);
    }
  }

  // ─── IAS Zone ──────────────────────────────────────────────────────────

  async _setupIASZone(zclNode) {
    const iasZone = zclNode.endpoints[ENDPOINT_ID].clusters[CLUSTER.IAS_ZONE.NAME];
    if (!iasZone) {
      this.error('[IAS] Cluster missing on endpoint 1');
      return;
    }

    // Live zone status changes (gas detected / cleared / fault)
    iasZone.onZoneStatusChangeNotification = ({ zoneStatus }) => {
      this._markAliveFromAvailability?.('ias-report');
      this.log('[IAS] Status change -- raw:', zoneStatus);
      this._applyZoneStatus(zoneStatus);
    };

    // Re-enrollment after factory reset
    iasZone.onZoneEnrollRequest = () => {
      this.log('[IAS] Enroll request -- post-reset');
      this._sendEnrollResponse(iasZone);
    };

    // Read initial state on startup
    try {
      const attrs = await iasZone.readAttributes(['zoneState', 'zoneStatus', 'zoneId']);
      this.log(`[IAS] zoneState=${attrs.zoneState} zoneId=${attrs.zoneId}`);
      if (attrs.zoneStatus !== undefined) {
        this._applyZoneStatus(attrs.zoneStatus);
      }
    } catch (err) {
      this.log('[IAS] Could not read initial attributes:', err.message);
    }

    await this._sendEnrollResponse(iasZone);
  }

  async _sendEnrollResponse(iasZone) {
    try {
      await iasZone.zoneEnrollResponse({ enrollResponseCode: 0x00, zoneId: IAS_ZONE_ID });
      this.log(`[IAS] Enroll response sent (zoneId=${IAS_ZONE_ID})`);
    } catch (err) {
      this.error('[IAS] Enroll response failed:', err.message);
    }
  }

  // ─── Availability ────────────────────────────────────────────────────────

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._markAliveFromAvailability?.('end-device-announce');
  }

  // ─── Zone status ───────────────────────────────────────────────────────

  /**
   * Parse IAS zoneStatus bitmap and update capabilities.
   * Fires flow triggers and push notification on alarm_gas transitions.
   * alarm_problem is gated by the alarm_problem_enabled setting.
   */
  _applyZoneStatus(zoneStatus) {
    const bitmap = this._toUint16(zoneStatus);

    const gasDetected = !!(bitmap & IAS_BIT_ALARM1);
    const fault = !!(bitmap & IAS_BIT_TROUBLE);
    const test = !!(bitmap & IAS_BIT_TEST);

    this.log(`[IAS] gas=${gasDetected} fault=${fault} test=${test} (0x${bitmap.toString(16).padStart(4, '0')})`);

    const previousGas = this.getCapabilityValue('alarm_gas');

    // Only fire flows and notifications on state transitions
    if (gasDetected !== previousGas) {
      this._setCapSafe('alarm_gas', gasDetected);

      if (gasDetected) {
        this.log('[IAS] Gas alarm ON');
      } else {
        this.log('[IAS] Gas alarm OFF');
      }
    } else {
      // Repeated report -- keep capability in sync without triggering flows
      this._setCapSafe('alarm_gas', gasDetected);
    }

    // alarm_problem gated by setting
    if (this.getSetting('alarm_problem_enabled') !== false) {
      this._setCapSafe('alarm_problem', fault);
    } else if (!fault) {
      this._setCapSafe('alarm_problem', false);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Normalise zoneStatus to a uint16 number.
   * Handles: Buffer, Buffer-like {type:'Buffer',data:[]}, number, named-key object.
   */
  _toUint16(value) {
    if (Buffer.isBuffer(value)) return value.readUInt16LE(0);
    if (value.type === 'Buffer' && Array.isArray(value.data))
      return Buffer.from(value.data).readUInt16LE(0);
    if (typeof value === 'number') return value;
    // Named-key object (zigbee-clusters parsed struct)
    const bits = {
      alarm1: IAS_BIT_ALARM1, alarm2: 0x0002, tamper: 0x0004,
      trouble: IAS_BIT_TROUBLE, acMains: 0x0010, test: IAS_BIT_TEST,
      batteryDefect: 0x0040,
    };
    return Object.entries(bits).reduce(
      (acc, [k, mask]) => value[k] ? acc | mask : acc, 0
    );
  }

  /** Set capability only when value changes; silently skip missing capabilities. */
  _setCapSafe(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value)
      .catch(err => this.error(`Failed to set ${capability}:`, err.message));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  onDeleted() {
    // Restore zclNode.handleFrame to the original before our mfg-specific filter was installed.
    if (this.zclNode && this._origZclHandle !== undefined) {
      this.zclNode.handleFrame = this._origZclHandle;
    }
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }

}

module.exports = GasDetector;
