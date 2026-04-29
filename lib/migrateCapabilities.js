'use strict';

/**
 * Migrate device capabilities after driver changes.
 *
 * Use ONLY in drivers where capabilities were explicitly added or removed.
 * Do NOT apply as a blanket pattern — each driver's migration must be deliberate.
 *
 * @param {import('homey').Device} device
 * @param {object} config
 * @param {string[]} [config.remove] - Capabilities to remove if present
 * @param {string[]} [config.ensure] - Capabilities to add if missing
 */
async function migrateCapabilities(device, { remove = [], ensure = [] } = {}) {
  for (const cap of remove) {
    if (device.hasCapability(cap)) {
      device.log(`[migrate] Removing deprecated capability: ${cap}`);
      await device.removeCapability(cap).catch(err =>
        device.error(`[migrate] removeCapability ${cap}:`, err.message)
      );
    }
  }
  for (const cap of ensure) {
    if (!device.hasCapability(cap)) {
      device.log(`[migrate] Adding missing capability: ${cap}`);
      await device.addCapability(cap).catch(err =>
        device.error(`[migrate] addCapability ${cap}:`, err.message)
      );
    }
  }
}

module.exports = { migrateCapabilities };
