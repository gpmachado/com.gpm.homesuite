'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * AqaraLumiCluster — cluster 0xFCC0 (64704)
 *
 * Aqara/Xiaomi proprietary protocol. Uses TLV binary encoding within
 * manufacturer-specific ZCL frames (manufacturer code 0x115F = 4447).
 *
 * FP1 (lumi.motion.ac01 / RTCZCGQ11LM) attributes:
 *   0x0142 (322) = presence        uint8   0=no, 1=yes, 255=null
 *   0x0143 (323) = presenceEvent   uint8   enter/leave/direction event
 *   0x0144 (324) = monitoringMode  uint8   0=undirected, 1=left_right
 *   0x0146 (326) = approachDist    uint8   0=far, 1=medium, 2=near
 *   0x010C (268) = motionSens      uint8   1=low, 2=medium, 3=high
 *   0x0150 (336) = regionConfig    buffer  7-byte region upsert/delete
 *   0x0151 (337) = regionEvent     buffer  2-byte [regionId, eventType]
 *   0x0157 (343) = resetPresence   uint8   write 1 to reset
 *
 * The same state is also reported through the index-based 0x00F7 struct:
 *   0x65 (101) = presence
 *   0x66 (102) = presenceEvent on old firmware, motionSensitivity on fw >= 50
 *   0x67 (103) = monitoringMode
 *   0x69 (105) = approachDistance
 */

const MANUFACTURER_CODE = 0x115F;
const CLUSTER_ID = 0xFCC0;

const ATTRIBUTES = {
  presence:             { id: 0x0142, type: ZCLDataTypes.uint8, manufacturerCode: MANUFACTURER_CODE },
  presenceEvent:        { id: 0x0143, type: ZCLDataTypes.uint8, manufacturerCode: MANUFACTURER_CODE },
  monitoringMode:       { id: 0x0144, type: ZCLDataTypes.uint8, manufacturerCode: MANUFACTURER_CODE },
  approachDistance:     { id: 0x0146, type: ZCLDataTypes.uint8, manufacturerCode: MANUFACTURER_CODE },
  motionSensitivity:    { id: 0x010C, type: ZCLDataTypes.uint8, manufacturerCode: MANUFACTURER_CODE },
  resetPresenceStatus:  { id: 0x0157, type: ZCLDataTypes.uint8, manufacturerCode: MANUFACTURER_CODE },
  regionEvent:          { id: 0x0151, type: ZCLDataTypes.buffer, manufacturerCode: MANUFACTURER_CODE },

  // FP1 struct attributes — parsed as raw buffers, decoded in device.js
  aqaraStructF7:        { id: 0x00F7, type: ZCLDataTypes.buffer, manufacturerCode: MANUFACTURER_CODE },
  aqaraStructDF:        { id: 0x00DF, type: ZCLDataTypes.buffer, manufacturerCode: MANUFACTURER_CODE },
};

const COMMANDS = {};

class AqaraLumiCluster extends Cluster {

  static get ID() {
    return CLUSTER_ID; // 0xFCC0 = 64704
  }

  static get NAME() {
    return 'manuSpecificLumi';
  }

  static get ATTRIBUTES() {
    return ATTRIBUTES;
  }

  static get COMMANDS() {
    return COMMANDS;
  }

  static get MANUFACTURER_CODE() {
    return MANUFACTURER_CODE;
  }

}

// ── TLV Parser (legacy format fw < 50) ──

/**
 * Parse the Aqara index/type/value structure carried by attributes 0x00F7
 * and 0x00DF.
 *
 * Each entry is encoded as:
 *   [index: uint8][ZCL data type: uint8][value: data-type-sized]
 *
 * Example from an FP1:
 *   65 20 01 = index 0x65, uint8, value 1 (presence)
 *
 * Depending on the zigbee-clusters decoding path, the buffer may retain the
 * ZCL octet-string length byte. For example, a 45-byte struct arrives as
 * `2d 03 28 ...`; that leading `2d` is not an Aqara index.
 *
 * @param {Buffer} buf
 * @returns {Object} { [index]: { type, length, value }, ... }
 */
AqaraLumiCluster.parseTLV = function(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return {};

  const result = {};
  const hasOctetStringLengthPrefix = buf[0] === buf.length - 1;
  let pos = hasOctetStringLengthPrefix ? 1 : 0;

  while (pos + 1 < buf.length) {
    const index = buf[pos++];
    const type = buf[pos++];
    let length;
    let value;

    switch (type) {
      case 0x00: // no data
        length = 0;
        value = null;
        break;
      case 0x08: // data8
      case 0x18: // bitmap8
      case 0x20: // uint8
        length = 1;
        value = buf.readUInt8(pos);
        break;
      case 0x09: // data16
      case 0x19: // bitmap16
      case 0x21: // uint16
        length = 2;
        value = buf.readUInt16LE(pos);
        break;
      case 0x0B: // data32
      case 0x1B: // bitmap32
      case 0x23: // uint32
        length = 4;
        value = buf.readUInt32LE(pos);
        break;
      case 0x10: // bool
        length = 1;
        value = buf[pos] === 1;
        break;
      case 0x28: // int8
        length = 1;
        value = buf.readInt8(pos);
        break;
      case 0x29: // int16
        length = 2;
        value = buf.readInt16LE(pos);
        break;
      case 0x2B: // int32
        length = 4;
        value = buf.readInt32LE(pos);
        break;
      case 0x39: // single precision
        length = 4;
        value = buf.readFloatLE(pos);
        break;
      case 0x41: // octet string
      case 0x42: { // character string
        if (pos >= buf.length) return result;
        const stringLength = buf[pos++];
        if (pos + stringLength > buf.length) return result;
        length = stringLength;
        const stringValue = buf.subarray(pos, pos + stringLength);
        value = type === 0x42 ? stringValue.toString('utf8') : stringValue;
        break;
      }
      default:
        // Do not guess the size of an unknown ZCL data type; retaining entries
        // already decoded is safer than shifting the remainder of the payload.
        return result;
    }

    if (pos + length > buf.length) return result;
    result[index] = { type, length, value };
    pos += length;
  }

  return result;
};

module.exports = AqaraLumiCluster;
