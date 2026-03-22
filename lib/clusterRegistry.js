'use strict';

const { Cluster } = require('zigbee-clusters');

/**
 * @file clusterRegistry.js
 * @description Registers all custom Zigbee clusters once at app startup.
 *
 * Calling Cluster.addCluster() in individual device files causes redundant
 * global re-registration on every driver load. Centralizing here ensures
 * each cluster is registered exactly once regardless of how many drivers use it.
 *
 * Usage: call registerCustomClusters() in app.js onInit().
 */

let _registered = false;

/**
 * Register all custom clusters. Safe to call multiple times (idempotent).
 * Must be called before any ZigBeeDevice initializes.
 */
function registerCustomClusters() {
  if (_registered) return;
  _registered = true;

  const TuyaBasicCluster = require('./TuyaBasicCluster');
  const TuyaSpecificCluster = require('./TuyaSpecificCluster');
  const ExtendedOnOffCluster = require('./ExtendedOnOffCluster');
  const TuyaPowerOnStateCluster = require('./TuyaPowerOnStateCluster');
  const TuyaE000Cluster = require('./TuyaE000Cluster');
  const { TuyaTimeCluster } = require('./TimeCluster');
  const SonoffCluster = require('./SonoffCluster');

  Cluster.addCluster(TuyaBasicCluster);
  Cluster.addCluster(TuyaSpecificCluster);
  Cluster.addCluster(ExtendedOnOffCluster);
  Cluster.addCluster(TuyaPowerOnStateCluster);
  Cluster.addCluster(TuyaE000Cluster);
  Cluster.addCluster(TuyaTimeCluster);
  Cluster.addCluster(SonoffCluster);

}

module.exports = { registerCustomClusters };
