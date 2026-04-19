'use strict';

const { isDeviceUnreachable } = require('./zigbeeErrorUtils');

function _isOfflineError(err) {
  return isDeviceUnreachable(err) ||
    !!(err && err.message && err.message.includes('Timeout'));
}

/**
 * Returns a `.catch()` handler for readAttributes calls.
 * Reachability errors ("Could not reach device", "Timeout") are expected when
 * a device is powered off — log at info level to keep the log clean.
 *
 * Options:
 *   markOffline {boolean} — call setUnavailable() when device can't be reached.
 *
 * @param {object} device
 * @param {string} label
 * @param {object} [opts]
 * @param {boolean} [opts.markOffline]
 * @returns {function}
 */
function readAttrCatch(device, label, { markOffline = false } = {}) {
  return err => {
    if (_isOfflineError(err)) {
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
