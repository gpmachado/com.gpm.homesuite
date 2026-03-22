'use strict';

const { BoundCluster } = require('zigbee-clusters');

/**
 * TimeSilentBoundCluster
 *
 * Registered via endpoint.bind('time', ...) to suppress
 * "binding_unavailable" log spam from Tuya TS0601 devices
 * that have an OUTPUT binding to the coordinator's Time cluster (0x000A).
 *
 * These devices request time via ZCL readAttributes on the Time cluster.
 * Without a BoundCluster registered, zigbee-clusters emits binding_unavailable
 * at the endpoint level — which cannot be suppressed by cluster-level listeners.
 *
 * This BoundCluster silently absorbs those frames.
 */
class TimeSilentBoundCluster extends BoundCluster {
  // No handlers needed — base class absorbs all incoming frames silently.
}

module.exports = TimeSilentBoundCluster;
