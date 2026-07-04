'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const AqaraLumiCluster = require('../../lib/AqaraLumiCluster');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

const AQARA_MFG = 0x115F;

const SENSITIVITY_MAP = { low: 1, medium: 2, high: 3, 1: 'low', 2: 'medium', 3: 'high' };
const MONITORING_MAP = { undirected: 0, left_right: 1, 0: 'undirected', 1: 'left_right' };
const APPROACH_MAP = { far: 0, medium: 1, near: 2, 0: 'far', 1: 'medium', 2: 'near' };
const PRESENCE_EVENT_MAP = {
  0: 'enter',
  1: 'leave',
  2: 'left_enter',
  3: 'right_leave',
  4: 'right_enter',
  5: 'left_leave',
  6: 'approach',
  7: 'away',
};

const ATTR = {
  motionSensitivity: 0x010C,
  presence: 0x0142,
  presenceEvent: 0x0143,
  monitoringMode: 0x0144,
  approachDistance: 0x0146,
  resetPresence: 0x0157,
};

class AqaraFP1Device extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    // FP1 is mains-powered and reports continuously. Count its raw inbound
    // frames so it appears in the Zigbee Traffic report like the Linptech.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: 12 * 60 * 60 * 1000,
      pollBeforeOffline: false,
    });
    await this._availability.install();

    this._presence = null;
    this._lastTemp = null;

    const lumiCluster = zclNode.endpoints[1].clusters.manuSpecificLumi;
    if (!lumiCluster) {
      this.error('[FP1] manuSpecificLumi cluster not available');
      return;
    }

    // Listen for attribute reports on the manuSpecificLumi cluster
    this._onAttr = (data, name) => this._handleAttrReport(name, data);

    const attrs = ['presence', 'presenceEvent', 'motionSensitivity', 'monitoringMode',
                   'approachDistance', 'resetPresenceStatus',
                   'aqaraStructF7', 'aqaraStructDF'];
    for (const name of attrs) {
      lumiCluster.on(`attr.${name}`, value => this._onAttr(value, name));
    }

    // Also listen for raw command events (cluster-specific commands like region)
    lumiCluster.on('command', cmd => this._handleCommand(cmd));

    this.log('[FP1] lumi.motion.ac01 initialized');

    // Read initial state
    try {
      const result = await lumiCluster.readAttributes(
        [ATTR.presence, ATTR.motionSensitivity, ATTR.monitoringMode, ATTR.approachDistance],
        { manufacturerCode: AQARA_MFG }
      );
      this.log('[FP1] Init read:', JSON.stringify(result));
    } catch (err) {
      this.log('[FP1] Initial read deferred:', err.message);
    }
  }

  _handleAttrReport(name, value) {
    this.log(`[FP1] attr.${name}:`, this._fmtValue(value));

    switch (name) {
      case 'presence':
        if (value === 255 || value === null) {
          this._presence = null;
        } else {
          this._presence = value === 1;
        }
        this._setCap('alarm_occupancy', this._presence);
        break;

      case 'presenceEvent':
        this.log(`[FP1] presence event: ${PRESENCE_EVENT_MAP[value] || value}`);
        break;

      case 'motionSensitivity':
        this.log(`[FP1] motion sensitivity: ${SENSITIVITY_MAP[value] || value}`);
        break;

      case 'monitoringMode':
        this.log(`[FP1] monitoring mode: ${MONITORING_MAP[value] || value}`);
        break;

      case 'approachDistance':
        this.log(`[FP1] approach distance: ${APPROACH_MAP[value] || value}`);
        break;

      case 'resetPresenceStatus':
        this.log(`[FP1] reset presence: ${value}`);
        break;

      case 'aqaraStructF7':
        this._parseAqaraStruct(value);
        break;

      case 'aqaraStructDF':
        this.log(`[FP1] struct DF: ${Buffer.isBuffer(value) ? value.toString('hex') : value}`);
        break;

      default:
        this.log(`[FP1] unhandled attr: ${name}=${this._fmtValue(value)}`);
    }
  }

  // Parse legacy TLV struct 0x00F7
  _parseAqaraStruct(buf) {
    if (!Buffer.isBuffer(buf)) return;
    const tlv = AqaraLumiCluster.parseTLV(buf);
    this.log(`[FP1] struct F7 parsed:`, JSON.stringify(tlv));

    // Index-based attributes in legacy struct
    for (const [pos, entry] of Object.entries(tlv)) {
      const index = Number(pos);
      const val = entry.value;

      if (index === 0x65) { // 101 = presence
        this._presence = val === 1;
        this._setCap('alarm_occupancy', this._presence);
        this.log(`[FP1] presence: ${this._presence}`);
      }
      // The interview reports appVersion 72. On firmware >= 50, index 0x66
      // carries sensitivity; older FP1 firmware used it for presence events.
      if (index === 0x66) this.log(`[FP1] motion sensitivity:`, SENSITIVITY_MAP[val] || val);
      if (index === 0x67) this.log(`[FP1] monitoring:`, MONITORING_MAP[val] || val);
      if (index === 0x69) this.log(`[FP1] approach:`, APPROACH_MAP[val] || val);
    }
  }

  _fmtValue(value) {
    if (Buffer.isBuffer(value)) return `Buffer(${value.length}B)`;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  _setCap(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value).catch(err => this.error(`[FP1] setCap ${capability}:`, err.message));
  }

  async onSettings({ newSettings, changedKeys }) {
    for (const key of changedKeys) {
      switch (key) {
        case 'motion_sensitivity': {
          const val = SENSITIVITY_MAP[newSettings.motion_sensitivity] || 2;
          await this._writeAttr(ATTR.motionSensitivity, 0x20, val);
          break;
        }
        case 'monitoring_mode': {
          const val = MONITORING_MAP[newSettings.monitoring_mode] || 0;
          await this._writeAttr(ATTR.monitoringMode, 0x20, val);
          break;
        }
        case 'approach_distance': {
          const val = APPROACH_MAP[newSettings.approach_distance] || 1;
          await this._writeAttr(ATTR.approachDistance, 0x20, val);
          break;
        }
      }
    }
  }

  async _writeAttr(attrId, dataType, value) {
    try {
      const cluster = this.zclNode?.endpoints?.[1]?.clusters?.manuSpecificLumi;
      if (!cluster) throw new Error('Cluster not available');
      await cluster.writeAttributes(
        { [attrId]: value },
        { manufacturerCode: AQARA_MFG }
      );
      this.log(`[FP1] Wrote attr 0x${attrId.toString(16)} = ${value}`);
    } catch (err) {
      this.error(`[FP1] Write attr 0x${attrId.toString(16)} failed:`, err.message);
    }
  }

  async _teardown() {
    if (this._availability) {
      await this._availability.uninstall();
      this._availability = null;
    }

    const lumiCluster = this.zclNode?.endpoints?.[1]?.clusters?.manuSpecificLumi;
    if (lumiCluster) {
      const attrs = ['presence', 'presenceEvent', 'motionSensitivity', 'monitoringMode',
                     'approachDistance', 'resetPresenceStatus',
                     'aqaraStructF7', 'aqaraStructDF'];
      for (const name of attrs) {
        lumiCluster.removeAllListeners(`attr.${name}`);
      }
      lumiCluster.removeAllListeners('command');
    }
  }

  async onDeleted() {
    await this._teardown();
    this.log('[FP1] Device removed');
  }

}

module.exports = AqaraFP1Device;
