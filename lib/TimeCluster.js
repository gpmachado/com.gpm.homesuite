'use strict';

const { Cluster, BoundCluster } = require('zigbee-clusters');

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
      time:           { id: 0, type: 'utcTime'  },
      timeStatus:     { id: 1, type: 'bitmap8'  },
      timeZone:       { id: 2, type: 'int32'    },
      dstStart:       { id: 3, type: 'uint32'   },
      dstEnd:         { id: 4, type: 'uint32'   },
      dstShift:       { id: 5, type: 'int32'    },
      standardTime:   { id: 6, type: 'uint32'   },
      localTime:      { id: 7, type: 'uint32'   },
      lastSetTime:    { id: 8, type: 'utcTime'  },
      validUntilTime: { id: 9, type: 'utcTime'  },
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
 */
class TimeSilentBoundCluster extends BoundCluster {
  // No handlers — base class absorbs all incoming frames silently.
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
