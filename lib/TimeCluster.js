'use strict';

const { Cluster, BoundCluster, ZCLDataTypes } = require('zigbee-clusters');

const ZIGBEE_EPOCH = 946684800;

function getZigbeeUtcSeconds() {
  return Math.floor(Date.now() / 1000) - ZIGBEE_EPOCH;
}

function getTimezoneOffsetSeconds() {
  return new Date().getTimezoneOffset() * -60;
}

/**
 * TuyaTimeCluster — ZCL Time cluster (0x000A) schema.
 *
 * Registered globally via clusterRegistry.js (Cluster.addCluster) so the
 * framework can parse/serialize Time cluster attributes when the app reads
 * or writes them.
 */
class TuyaTimeCluster extends Cluster {

  static get ID() {
    return 10; // 0x000A
  }

  static get NAME() {
    return 'time';
  }

  static get ATTRIBUTES() {
    return {
      time:           { id: 0, type: ZCLDataTypes.uint32 },
      timeStatus:     { id: 1, type: ZCLDataTypes.map8('master', 'synchronized', 'masterZoneDst', 'superseding') },
      timeZone:       { id: 2, type: ZCLDataTypes.int32 },
      dstStart:       { id: 3, type: ZCLDataTypes.uint32 },
      dstEnd:         { id: 4, type: ZCLDataTypes.uint32 },
      dstShift:       { id: 5, type: ZCLDataTypes.int32 },
      standardTime:   { id: 6, type: ZCLDataTypes.uint32 },
      localTime:      { id: 7, type: ZCLDataTypes.uint32 },
      lastSetTime:    { id: 8, type: ZCLDataTypes.uint32 },
      validUntilTime: { id: 9, type: ZCLDataTypes.uint32 },
    };
  }

  static get COMMANDS() {
    return {};
  }
}

/**
 * TimeSilentBoundCluster — silently absorbs incoming Time cluster frames.
 *
 * Registered via endpoint.bind('time', new TimeSilentBoundCluster()) to
 * suppress "binding_unavailable" log spam from Tuya devices that have an
 * output binding to the coordinator's Time cluster (e.g. TS0003, TS0601).
 * Without this, zigbee-clusters emits binding_unavailable for every frame
 * because no BoundCluster is registered at the endpoint level.
 *
 * Keep the Time cluster attributes backed by real ZCLDataTypes so the
 * BoundCluster can serialize readAttribute responses.
 */
class TimeSilentBoundCluster extends BoundCluster {
  constructor({ onReadAttributes } = {}) {
    super();
    this._onReadAttributes = onReadAttributes;
  }

  async readAttributes(args) {
    if (args?.attributes?.some(attrId => attrId === 0 || attrId === 7)) {
      this._onReadAttributes?.(args);
    }
    return super.readAttributes(args);
  }

  get time() {
    return getZigbeeUtcSeconds();
  }

  get timeStatus() {
    return { master: true, synchronized: true, masterZoneDst: true };
  }

  get timeZone() {
    return getTimezoneOffsetSeconds();
  }

  get standardTime() {
    return this.localTime;
  }

  get localTime() {
    return getZigbeeUtcSeconds() + getTimezoneOffsetSeconds();
  }

  get lastSetTime() {
    return this.time;
  }

  get validUntilTime() {
    return this.time + 86400;
  }
}

/**
 * BasicSilentBoundCluster — silently absorbs incoming Basic cluster (0x0000) frames.
 *
 * Registered via endpoint.bind('basic', new BasicSilentBoundCluster()) to
 * suppress "error while sending default error response" spam that occurs when
 * Tuya devices send unsolicited reportAttributes on cluster 0 during init and
 * the ZCL stack tries to ACK back to a device that is already unreachable.
 */
class BasicSilentBoundCluster extends BoundCluster {
  // No handlers — base class absorbs all incoming frames silently.
}

module.exports = { TuyaTimeCluster, TimeSilentBoundCluster, BasicSilentBoundCluster };
