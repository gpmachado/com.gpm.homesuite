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

// ─── Sibling detection ────────────────────────────────────────────────────────

/**
 * Returns all Homey device instances that share the same physical Zigbee node
 * as `device`, matched by ieeeAddress.
 *
 * @param {ZigBeeDevice} device - the calling device instance
 * @returns {Array} sibling device instances (includes `device` itself)
 */
function getNodeDevices(device) {
  // zclNode is always shared by all sub-devices of the same physical Zigbee node
  // and is more reliable than ieeeAddress (which may be absent on sub-devices).
  const myZclNode = device.zclNode;
  const myIeee    = device.getData()?.ieeeAddress;
  return device.driver.getDevices().filter(d => {
    try {
      if (myZclNode) return d.zclNode === myZclNode;
      if (myIeee)    return d.getData().ieeeAddress === myIeee;
      return false;
    } catch { return false; }
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

// ─── Sibling label sync (high-level) ─────────────────────────────────────────

/**
 * Get siblings, optionally sort them, and write the device_siblings_info label.
 *
 * @param {ZigBeeDevice} device
 * @param {object}  [opts]
 * @param {boolean} [opts.mainOnly=false]  skip if device is not the main sub-device
 * @param {Function}[opts.sortFn]          comparator passed to Array.sort()
 */
async function updateSiblingNames(device, { mainOnly = false, sortFn } = {}) {
  if (mainOnly && device.getData().subDeviceId) return;
  try {
    const siblings = getNodeDevices(device);
    if (sortFn) siblings.sort(sortFn);
    await writeSiblingNames(siblings);
  } catch (err) {
    device.error('Error updating sibling names:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { getNodeDevices, writeSiblingNames, updateSiblingNames };
