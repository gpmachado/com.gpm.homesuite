'use strict';

/**
 * Returns a `.catch()` handler for readAttributes calls.
 * "Could not reach device" is expected when a device is powered off —
 * log at info level instead of error to keep the log clean.
 *
 * Options:
 *   markOffline {boolean} — call setUnavailable() when device can't be reached.
 *     Use for drivers that manage availability manually (e.g. AvailabilityManagerCluster0).
 *     Leave false (default) for homey-zigbeedriver devices where the framework handles it.
 *
 * Usage:
 *   cluster.readAttributes([...]).catch(readAttrCatch(this, '[EP1] readAttributes onOff'));
 *   cluster.readAttributes([...]).catch(readAttrCatch(this, '[basic] readAttributes', { markOffline: true }));
 *
 * @param {object} device                  - Homey device instance (has .log / .error)
 * @param {string} label                   - log prefix, e.g. '[EP1] readAttributes tuyaPowerOnState'
 * @param {object} [opts]
 * @param {boolean} [opts.markOffline]     - call setUnavailable() when device is unreachable
 * @returns {function}
 */
function readAttrCatch(device, label, { markOffline = false } = {}) {
  return err => {
    if (err && err.message && err.message.includes('Could not reach device')) {
      device.log(`${label}: device offline (not powered)`);
      if (markOffline) {
        device.setUnavailable('Device not reachable').catch(() => {});
      }
    } else {
      device.error(`${label}:`, err);
    }
  };
}

module.exports = { readAttrCatch };
