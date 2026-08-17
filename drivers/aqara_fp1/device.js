'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const AqaraLumiCluster = require('../../lib/AqaraLumiCluster');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { TimeServerBoundCluster } = require('../../lib/TimeCluster');

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

    // FP1 doesn't declare the Time cluster in its own cluster list, but still
    // probes it — without a bound cluster this logs binding_unavailable on
    // every attempt (interview-confirmed: no 'time' entry in input/output clusters).
    try { zclNode.endpoints[1].bind('time', new TimeServerBoundCluster()); } catch {}

    this._presenceEventTrigger = this.homey.flow.getDeviceTriggerCard('aqara_fp1_presence_event');

    // FP1 is mains-powered and reports continuously. Count its raw inbound
    // frames so it appears in the Zigbee Traffic report like the Linptech.
    this._availability = new AvailabilityManagerPassive(this, {
      timeout: 12 * 60 * 60 * 1000,
      pollBeforeOffline: false,
    });
    await this._availability.install();

    this._presence = null;
    this._lastTemp = null;
    this._lastPowerOutageCount = null;

    for (const capability of ['measure_temperature']) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(err => this.error(`[FP1] addCapability ${capability}:`, err.message));
      }
    }

    await this._syncPowerOutageCountCapability(this.getSetting('show_power_outage_count'));

    const lumiCluster = zclNode.endpoints[1].clusters.manuSpecificLumi;
    if (!lumiCluster) {
      this.error('[FP1] manuSpecificLumi cluster not available');
      return;
    }

    // Listen for attribute reports on the manuSpecificLumi cluster
    this._onAttr = (data, name) => this._handleAttrReport(name, data);

    const attrs = ['presence', 'presenceEvent', 'motionSensitivity', 'monitoringMode',
                   'approachDistance', 'resetPresenceStatus',
                   'aqaraLifeline',
                   'aqaraStructF7', 'aqaraStructDF'];
    for (const name of attrs) {
      lumiCluster.on(`attr.${name}`, value => this._onAttr(value, name));
    }

    // Also listen for raw command events (cluster-specific commands like region)
    lumiCluster.on('command', cmd => this._handleCommand(cmd));

    // Aqara sends 0x00F7 / 0x00DF as raw manufacturer reports, not named attr events.
    lumiCluster.on('reportAttributes', data => this._handleRawReport(data));

    this.log('[FP1] lumi.motion.ac01 initialized');

    // Read initial state
    try {
      const result = await lumiCluster.readAttributes(
        [ATTR.presence, ATTR.motionSensitivity, ATTR.monitoringMode, ATTR.approachDistance,
         0x00F7, 0x00DF],
        { manufacturerCode: AQARA_MFG }
      );
      this.log('[FP1] Init read:', JSON.stringify(result));
      for (const [key, value] of Object.entries(result || {})) {
        if (Buffer.isBuffer(value)) {
          if (Number(key) === 0x00F7 || key === 'aqaraStructF7' || key === 'aqaraLifeline') {
            this._parseAqaraStruct(value);
          }
          if (Number(key) === 0x00DF || key === 'aqaraStructDF') {
            this._parseHeartbeatStruct(value);
          }
        }
      }
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
        this._triggerPresenceEvent(value);
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
      case 'aqaraLifeline':
        this._parseAqaraStruct(value);
        break;

      case 'aqaraStructDF':
        this._parseHeartbeatStruct(value);
        break;

      default:
        this.log(`[FP1] unhandled attr: ${name}=${this._fmtValue(value)}`);
    }
  }

  _handleCommand(cmd) {
    this.log('[FP1] raw command:', this._fmtValue(cmd));
  }

  _handleRawReport(data) {
    const buf = data?.attributes;
    if (!Buffer.isBuffer(buf) || buf.length < 4) return;

    const attrId = buf.readUInt16LE(0);
    const type = buf.readUInt8(2);
    let value = null;

    if (type === 0x41 || type === 0x42) {
      const len = buf.readUInt8(3);
      if (buf.length < 4 + len) return;
      value = buf.subarray(4, 4 + len);
    } else {
      value = buf.subarray(2);
    }

    if (attrId === 0x00F7) {
      this._parseAqaraStruct(value);
    } else if (attrId === 0x00DF) {
      this._parseHeartbeatStruct(value);
    }
  }

  _triggerPresenceEvent(value) {
    const event = PRESENCE_EVENT_MAP[value] || String(value);
    this.log(`[FP1] presence event: ${event}`);
    this._presenceEventTrigger?.trigger(this, {
      event,
      event_id: String(value),
    }).catch(err => this.error('[FP1] presence event trigger failed:', err.message));
  }

  // Parse legacy TLV struct 0x00F7
  _parseAqaraStruct(buf) {
    if (!Buffer.isBuffer(buf)) return;
    this.log(`[FP1] _parseAqaraStruct called, buf len=${buf.length}, first bytes: ${buf.subarray(0, 10).toString('hex')}`);
    const tlv = AqaraLumiCluster.parseTLV(buf);
    this.log(`[FP1] struct F7 parsed:`, JSON.stringify(tlv));

    // Index-based attributes in legacy struct
    for (const [pos, entry] of Object.entries(tlv)) {
      const index = Number(pos);
      const val = entry.value;

      if (index === 0x03) { // 3 = device_temperature (int8, degrees C)
        const temp = val;
        this.log(`[FP1] Found temperature index 0x03: ${temp}°C, hasCapability=${this.hasCapability('measure_temperature')}`);
        if (this._lastTemp !== temp) {
          this._lastTemp = temp;
          this._setCap('measure_temperature', temp);
          this.log(`[FP1] device_temperature: ${temp}°C`);
        }
      }
      if (index === 0x05) { // 5 = power_outage_count (uint8)
        const count = val;
        if (this._lastPowerOutageCount !== count) {
          this._lastPowerOutageCount = count;
          this._setCap('power_outage_count', count);
          this.log(`[FP1] power_outage_count: ${count}`);
        }
      }
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

  // Parse heartbeat struct 0x00DF — kept for future Aqara variants.
  _parseHeartbeatStruct(buf) {
    if (!Buffer.isBuffer(buf)) return;
    const tlv = AqaraLumiCluster.parseTLV(buf);
    this.log(`[FP1] struct DF parsed:`, JSON.stringify(tlv));

    for (const [pos, entry] of Object.entries(tlv)) {
      const index = Number(pos);
      const val = entry.value;

      // Index 0x03 = device temperature (int8)
      if (index === 0x03) {
        const temp = val;
        if (this._lastTemp !== temp) {
          this._lastTemp = temp;
          this._setCap('measure_temperature', temp);
          this.log(`[FP1] device_temperature (from DF): ${temp}°C`);
        }
      }
      // Index 0x05 = RSSI, 0x0A = parent NWK, 0x17 = battery mV — logged only
      if (index === 0x05) this.log(`[FP1] RSSI: ${val}`);
      if (index === 0x0A) this.log(`[FP1] parent NWK: 0x${val.toString(16).toUpperCase()}`);
      if (index === 0x17) this.log(`[FP1] battery mV: ${val}`);
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
    if (changedKeys.includes('show_power_outage_count')) {
      await this._syncPowerOutageCountCapability(newSettings.show_power_outage_count);
    }

    for (const key of changedKeys) {
      switch (key) {
        case 'motion_sensitivity': {
          const val = SENSITIVITY_MAP[newSettings.motion_sensitivity] || 2;
          await this._writeAttr('motionSensitivity', val);
          break;
        }
        case 'monitoring_mode': {
          const val = MONITORING_MAP[newSettings.monitoring_mode] || 0;
          await this._writeAttr('monitoringMode', val);
          break;
        }
        case 'approach_distance': {
          const val = APPROACH_MAP[newSettings.approach_distance] || 1;
          await this._writeAttr('approachDistance', val);
          break;
        }
      }
    }
  }

  async _syncPowerOutageCountCapability(showSetting) {
    const show = showSetting !== false;
    const capability = 'power_outage_count';

    try {
      if (show && !this.hasCapability(capability)) {
        await this.addCapability(capability);
      } else if (!show && this.hasCapability(capability)) {
        await this.removeCapability(capability);
      }
    } catch (err) {
      this.error(`[FP1] sync ${capability} capability failed:`, err.message);
    }
  }

  async _writeAttr(attrName, value) {
    try {
      const cluster = this.zclNode?.endpoints?.[1]?.clusters?.manuSpecificLumi;
      if (!cluster) throw new Error('Cluster not available');
      await cluster.writeAttributes({ [attrName]: value }, { manufacturerCode: AQARA_MFG });
      this.log(`[FP1] Wrote attr ${attrName} = ${value}`);
    } catch (err) {
      this.error(`[FP1] Write attr ${attrName} failed:`, err.message);
    }
  }

  async _resetPresence() {
    await this._writeAttr('resetPresenceStatus', 1);
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
      lumiCluster.removeAllListeners('reportAttributes');
    }
  }

  async onDeleted() {
    await this._teardown();
    this.log('[FP1] Device removed');
  }

}

module.exports = AqaraFP1Device;
