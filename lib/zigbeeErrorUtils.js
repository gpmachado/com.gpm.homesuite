'use strict';

/**
 * Returns true when a ZCL/Zigbee error is a reachability failure
 * ("Could not reach device") rather than an attribute/feature error
 * ("UNREPORTABLE_ATTRIBUTE", "NOT_SUPPORTED", etc.).
 *
 * Used to distinguish "retry after rejoin" from "polling is permanent fallback".
 */
function isDeviceUnreachable(err) {
  if (!err || !err.message) return false;
  return err.message.includes('Could not reach device') ||
         err.message.includes('Timeout');
}

module.exports = { isDeviceUnreachable };
