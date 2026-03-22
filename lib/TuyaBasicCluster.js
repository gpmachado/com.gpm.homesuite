'use strict';

const { BasicCluster, Cluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * Tuya-extended Basic cluster (0x0000).
 *
 * Tuya devices periodically send `reportAttributes` frames on the basic cluster
 * that include manufacturer-specific attribute IDs not defined in the standard
 * ZCL BasicCluster schema.  Without schema entries, `onReportAttributes` has no
 * name for the attribute and cannot emit `attr.*` events — so only `attr.appVersion`
 * (0x0001) would fire.
 *
 * Adding these IDs to the schema ensures every periodic frame emits an `attr.*`
 * event that devices can use for availability / heartbeat tracking.
 *
 * Observed private attrs by model:
 *   TS0003 (3-gang switch):  0xFFE2, 0xFFE4
 *   TS0207 (USB repeater):   0xFFDE, 0xFFE0, 0xFFE1, 0xFFE2, 0xFFE3
 *
 * @extends BasicCluster
 */
class TuyaBasicCluster extends BasicCluster {

  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,

      // ── Tuya private basic attributes ──────────────────────────────────────
      // Semantic meaning unknown; treated as opaque keepalive signals.
      // Wire type on all observed devices: uint8.

      ffde: { id: 0xFFDE, type: ZCLDataTypes.uint8 },  // TS0207
      ffe0: { id: 0xFFE0, type: ZCLDataTypes.uint8 },  // TS0207
      ffe1: { id: 0xFFE1, type: ZCLDataTypes.uint8 },  // TS0207
      ffe2: { id: 0xFFE2, type: ZCLDataTypes.uint8 },  // TS0003, TS0207
      ffe3: { id: 0xFFE3, type: ZCLDataTypes.uint8 },  // TS0207
      ffe4: { id: 0xFFE4, type: ZCLDataTypes.uint8 },  // TS0003
    };
  }
}

// Override the standard BasicCluster registration so the framework uses
// this extended schema for cluster 0x0000 on all endpoints.
Cluster.addCluster(TuyaBasicCluster);

module.exports = TuyaBasicCluster;
