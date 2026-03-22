'use strict';

const { Cluster } = require('zigbee-clusters');

/**
 * @file TuyaE000Cluster.js
 * @description Tuya proprietary cluster 0xE000 (57344).
 *
 * Present on EP1 only of all known Tuya switch/plug devices:
 *   TS011F  _TZ3000_88iqnhvd  smart plug (metering)
 *   TS0003  _TZ3000_fawk5xjv  3-gang wall switch
 *   (and other TS000x / TS011x variants)
 *
 * PURPOSE:
 *   Reports inching/countdown configuration via unsolicited reportAttributes
 *   frames sent on reconnect or after countdown changes.
 *   This cluster MUST be registered in clusterRegistry so the SDK routes
 *   incoming frames to a handler — without it every reconnect logs
 *   "cluster_unavailable" for each spontaneous report.
 *
 * ATTRIBUTE MAP (decoded from pcap):
 *   0xD001  inchingTime    — configured countdown duration in seconds (READ-ONLY here)
 *   0xD002  inchingRemain  — remaining countdown time in seconds      (READ-ONLY here)
 *
 * Both attributes use Tuya's non-standard type 0x48:
 *   wire format = [len: uint8 = 2][value: uint16 big-endian]
 *
 * HOW TO CONFIGURE COUNTDOWN (write path):
 *   Write onOff cluster attrs onTime (0x4001) + offWaitTime (0x4002)
 *   to the same value in seconds via ExtendedOnOffCluster — NOT via this cluster.
 *
 * TOPOLOGY:
 *   E000 is always EP1-only (global, not per-gang).
 *   E001 (TuyaPowerOnStateCluster) appears on every endpoint (per-gang).
 *
 * @extends Cluster
 */

/**
 * Tuya non-standard ZCL data type 0x48.
 * Wire format: [len: uint8 = 2][value: uint16 big-endian]
 * Used by Tuya firmware for uint16 values inside E000 attribute reports.
 *
 * `length: 3` (not `size`) is required so zigbee-clusters ZCLAttributeDataRecord
 * takes the fixed-size branch: `res.value = DataType.fromBuffer(buf, i)`.
 */
const tuyaUint16 = {
  id: 0x48,
  length: 3,
  fromBuffer(buf, i) {
    // i points to the data bytes (after the wire dataType byte).
    // Wire: [len=2: uint8][value: uint16BE] — skip len, return the uint16 value.
    return buf.readUInt16BE(i + 1);
  },
  toBuffer(buf, value, i) {
    buf.writeUInt8(2, i);
    buf.writeUInt16BE(value, i + 1);
    return 3; // bytes written
  },
};

class TuyaE000Cluster extends Cluster {

  static get ID() { return 0xE000; }
  static get NAME() { return 'tuyaE000'; }

  static get ATTRIBUTES() {
    return {
      /** Configured inching/countdown duration in seconds (0xD001). READ-ONLY. */
      inchingTime:   { id: 0xD001, type: tuyaUint16 },

      /** Remaining countdown time in seconds (0xD002). READ-ONLY. */
      inchingRemain: { id: 0xD002, type: tuyaUint16 },
    };
  }

  static get COMMANDS() { return {}; }
}

module.exports = TuyaE000Cluster;
