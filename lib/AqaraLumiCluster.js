'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * AqaraLumiCluster — cluster 0xFCC0 (64704)
 *
 * Aqara/Xiaomi proprietary protocol. Uses TLV binary encoding within
 * manufacturer-specific ZCL frames (manufacturer code 0x115F = 4447).
 *
 * Reference sources used to shape this registry:
 * - public Aqara/Hubitat community drivers for FP1 / FP1E / FP300 behavior
 * - Zigbee2MQTT / community converters for Aqara T1/T2 lifeline structures
 * - local interviews captured in `Homey_Interview/`
 *
 * The goal is to keep one shared Aqara namespace for:
 * - FP1-style presence and region attributes
 * - Aqara relay/switch configuration attributes
 * - packed lifeline structs that carry electrical measurements
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
 *   0x03 = device_temperature  int8    internal device temperature
 *   0x05 = power_outage_count   uint8   number of power outages since pairing
 *   0x65 (101) = presence
 *   0x66 (102) = presenceEvent on old firmware, motionSensitivity on fw >= 50
 *   0x67 (103) = monitoringMode
 *   0x69 (105) = approachDistance
 */

const MANUFACTURER_CODE = 0x115F;
const CLUSTER_ID = 0xFCC0;

/**
 * Helper for declaring manufacturer-specific attributes without repeating the
 * Aqara manufacturer code on every entry.
 */
const attr = (id, type) => ({ id, type, manufacturerCode: MANUFACTURER_CODE });

/**
 * Packed lifeline measurements used by Aqara T1/T2 relay and switch modules.
 * These are emitted inside the manufacturer-specific 0x00F7 struct and can be
 * mapped to Homey capabilities when a device driver chooses to do so.
 */
const LIFELINE_MEASUREMENTS = {
  149: { capability: 'meter_power', scale: 1 },
  150: { capability: 'measure_voltage', scale: 0.1 },
  151: { capability: 'measure_current', scale: 0.001 },
  152: { capability: 'measure_power', scale: 1 },
};

const ATTRIBUTES = {
  // Generic Aqara/Lumi attributes seen in public interviews and converters.
  detectionPeriod:      attr(0x0000, ZCLDataTypes.uint16),
  powerOutageCount:     attr(0x0002, ZCLDataTypes.uint16),
  buttonSpeed:          attr(0x0004, ZCLDataTypes.uint16),
  mode:                 attr(0x0009, ZCLDataTypes.uint8),
  deviceType:           attr(0x000A, ZCLDataTypes.uint8), // legacy/general name
  aqaraSwitchType:      attr(0x000A, ZCLDataTypes.uint8), // alias used by T1/T2 docs
  manufacturer:         attr(0x000B, ZCLDataTypes.string),
  event:                attr(0x000C, ZCLDataTypes.buffer),
  data13:               attr(0x000D, ZCLDataTypes.uint8),
  data14:               attr(0x000E, ZCLDataTypes.buffer),
  data15:               attr(0x000F, ZCLDataTypes.buffer),
  reportInterval:       attr(0x00F6, ZCLDataTypes.uint16),
  serialNumber:         attr(0x00FE, ZCLDataTypes.string),
  rawPayload:           attr(0x00FF, ZCLDataTypes.buffer),
  aqaraSwitchOperationMode: attr(0x0200, ZCLDataTypes.uint8),
  aqaraSwitchPowerOutageMemory: attr(0x0201, ZCLDataTypes.bool),
  aqaraWorkMode:        attr(0x0289, ZCLDataTypes.uint8),
  aqaraInterlock:       attr(0x02D0, ZCLDataTypes.bool),
  aqaraPulseLength:     attr(0x00EB, ZCLDataTypes.uint16),

  // FP1 / motion-presence attributes.
  motionSensitivity:    attr(0x010C, ZCLDataTypes.uint8),
  presence:             attr(0x0142, ZCLDataTypes.uint8),
  presenceEvent:        attr(0x0143, ZCLDataTypes.uint8),
  monitoringMode:       attr(0x0144, ZCLDataTypes.uint8),
  approachDistance:     attr(0x0146, ZCLDataTypes.uint8),
  regionConfig:         attr(0x0150, ZCLDataTypes.buffer),
  regionEvent:          attr(0x0151, ZCLDataTypes.buffer),
  resetPresenceStatus:  attr(0x0157, ZCLDataTypes.uint8),

  // FP1 / packed struct attributes. These are parsed as raw buffers and then
  // decoded by the driver with `parseTLV()` / `parseAqaraStruct()`.
  aqaraStructF7:        attr(0x00F7, ZCLDataTypes.buffer),
  aqaraLifeline:        attr(0x00F7, ZCLDataTypes.buffer), // alias for T1/T2 docs
  aqaraStructDF:        attr(0x00DF, ZCLDataTypes.buffer),
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

  static get LIFELINE_MEASUREMENTS() {
    return LIFELINE_MEASUREMENTS;
  }

}

/**
 * Decode a single ZCL-encoded value from a buffer.
 *
 * This is shared by the legacy FP1 TLV parser and the packed lifeline parser,
 * so both code paths keep the same type handling and fail closed on unknown
 * ZCL types.
 */
function readZclValue(buffer, pos, type) {
  let length = 0;
  let value;

  switch (type) {
    case 0x00: // no data
      value = null;
      break;
    case 0x08: // data8
    case 0x18: // bitmap8
    case 0x20: // uint8
      length = 1;
      value = buffer.readUInt8(pos);
      break;
    case 0x09: // data16
    case 0x19: // bitmap16
    case 0x21: // uint16
      length = 2;
      value = buffer.readUInt16LE(pos);
      break;
    case 0x0B: // data32
    case 0x1B: // bitmap32
    case 0x23: // uint32
      length = 4;
      value = buffer.readUInt32LE(pos);
      break;
    case 0x10: // bool
      length = 1;
      value = buffer[pos] === 1;
      break;
    case 0x22: // uint24
      length = 3;
      value = buffer.readUIntLE(pos, 3);
      break;
    case 0x24: // uint40
      length = 5;
      value = buffer.readUIntLE(pos, 5);
      break;
    case 0x25: // uint48
      length = 6;
      value = buffer.readUIntLE(pos, 6);
      break;
    case 0x27: // uint64
      length = 8;
      value = Number(buffer.readBigUInt64LE(pos));
      break;
    case 0x28: // int8
      length = 1;
      value = buffer.readInt8(pos);
      break;
    case 0x29: // int16
      length = 2;
      value = buffer.readInt16LE(pos);
      break;
    case 0x2A: // int24
      length = 3;
      value = buffer.readIntLE(pos, 3);
      break;
    case 0x2B: // int32
      length = 4;
      value = buffer.readInt32LE(pos);
      break;
    case 0x2F: // int64
      length = 8;
      value = Number(buffer.readBigInt64LE(pos));
      break;
    case 0x30: // enum8
      length = 1;
      value = buffer.readUInt8(pos);
      break;
    case 0x31: // enum16
      length = 2;
      value = buffer.readUInt16LE(pos);
      break;
    case 0x39: // single precision
      length = 4;
      value = buffer.readFloatLE(pos);
      break;
    case 0x3A: // double precision
      length = 8;
      value = buffer.readDoubleLE(pos);
      break;
    case 0x41: // octet string
    case 0x42: { // character string
      if (pos >= buffer.length) return null;
      const stringLength = buffer[pos];
      if (pos + 1 + stringLength > buffer.length) return null;
      length = 1 + stringLength;
      const stringValue = buffer.subarray(pos + 1, pos + 1 + stringLength);
      value = type === 0x42 ? stringValue.toString('utf8') : stringValue;
      break;
    }
    default:
      return null;
  }

  if (pos + length > buffer.length) return null;
  return { length, value };
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
    const decoded = readZclValue(buf, pos, type);
    if (!decoded) {
      // Do not guess the size of an unknown ZCL data type; retaining entries
      // already decoded is safer than shifting the remainder of the payload.
      return result;
    }

    result[index] = { type, length: decoded.length, value: decoded.value };
    pos += decoded.length;
  }

  return result;
};

/**
 * Parse Aqara packed lifeline structs, typically used by T1/T2 relay modules.
 *
 * This returns a simple `{ [key]: value }` map and intentionally stops on
 * unknown types to avoid misalignment. Driver code can use
 * `AqaraLumiCluster.LIFELINE_MEASUREMENTS` to translate known keys into Homey
 * capabilities.
 *
 * @param {Buffer} buffer
 * @returns {Record<number, any>}
 */
AqaraLumiCluster.parseAqaraStruct = function(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return {};

  const result = {};
  let pos = 0;

  while (pos + 1 < buffer.length) {
    const key = buffer.readUInt8(pos);
    const type = buffer.readUInt8(pos + 1);
    pos += 2;

    const decoded = readZclValue(buffer, pos, type);
    if (!decoded) return result;

    result[key] = decoded.value;
    pos += decoded.length;
  }

  return result;
};

// Backward-compatible alias for code that expects the FP1-style naming.
AqaraLumiCluster.parsePackedStruct = AqaraLumiCluster.parseAqaraStruct;

module.exports = AqaraLumiCluster;
