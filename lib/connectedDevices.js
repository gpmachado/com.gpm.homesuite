'use strict';

/**
 * connectedDevices.js
 *
 * Shared utilities for multi-endpoint / multi-gang / multi-socket devices
 * that register as separate Homey sub-devices sharing one physical Zigbee node.
 *
 * Used by: novadigital_switch_2/3/4/6_gang · moes_dimmer_3_gang · socket_power_strip
 * Available in TuyaSpecificClusterDevice as this._writeSiblingNames() / this._getNodeDevices()
 * Available in ZigBeeDevice drivers via direct require.
 */

const AvailabilityManager = require('./AvailabilityManager');

// ─── Sibling detection ────────────────────────────────────────────────────────

/**
 * Returns all Homey device instances that share the same physical Zigbee node
 * as `device`, matched by ieeeAddress.
 *
 * @param {ZigBeeDevice} device - the calling device instance
 * @returns {Array} sibling device instances (includes `device` itself)
 */
function getNodeDevices(device) {
  const myIeee = device.getData().ieeeAddress;
  return device.driver.getDevices().filter(d => {
    try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
  });
}

// ─── Sibling label sync ───────────────────────────────────────────────────────

/**
 * Writes the device_siblings_info label to ALL siblings.
 * Every device shows the full list with (Main) tagging the primary gang.
 *
 * @param {Array} siblings - already filtered and sorted by the calling driver
 */
async function writeSiblingNames(siblings) {
  if (!siblings.length) return;
  const infoText = siblings.map(d => {
    const isMain = !d.getData().subDeviceId;
    return isMain ? `${d.getName()} (Main)` : d.getName();
  }).join(' • ');
  await Promise.allSettled(
    siblings.map(d => d.setSettings({ device_siblings_info: infoText }).catch(() => {}))
  );
}

// ─── Availability ─────────────────────────────────────────────────────────────

/**
 * Fires the availability flow trigger card for the given device.
 * Use inside onBecameAvailable / onBecameUnavailable on ZigBeeDevice drivers
 * (TuyaSpecificClusterDevice handles this automatically via its base methods).
 *
 * @param {ZigBeeDevice} device
 * @param {boolean} available
 */
function triggerAvailability(device, available) {
  AvailabilityManager.trigger(device, available);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { getNodeDevices, writeSiblingNames, triggerAvailability };
