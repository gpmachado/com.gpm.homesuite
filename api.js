'use strict';

/**
 * App Settings API.
 *
 * Only devices with an AvailabilityManager are returned. Multi-gang drivers
 * install the manager on their main/EP1 device only, producing one row per
 * physical Zigbee node.
 */
module.exports = {
  async getMessageStats({ homey }) {
    const rowsByPhysicalDevice = new Map();
    const drivers = homey.drivers.getDrivers();

    for (const [driverId, driver] of Object.entries(drivers)) {
      for (const device of driver.getDevices()) {
        const manager = device._availability;
        if (!manager || typeof manager.getMessageStats !== 'function') continue;

        const data = device.getData?.() || {};
        const settings = device.getSettings?.() || {};
        const physicalId = data.ieeeAddress
          || settings.zb_ieee_address
          || device.getId();
        const fullStats = manager.getMessageStats();
        const stats = {
          mode: fullStats.mode,
          currentHour: fullStats.currentHour,
          previousHour: fullStats.previousHour,
          last24h: fullStats.last24h,
          lastMessageAt: fullStats.lastMessageAt,
          bySource: fullStats.bySource,
        };

        const row = {
          id: device.getId(),
          physicalId,
          endpoint: 1,
          name: device.getName(),
          zone: device.getZone?.()?.getName?.() || '',
          driverId,
          modelId: data.modelId || settings.zb_product_id || '',
          manufacturerName:
            data.manufacturerName || settings.zb_manufacturer_name || '',
          available: device.getAvailable(),
          stats,
        };

        const existing = rowsByPhysicalDevice.get(physicalId);
        const isMain = !data.subDeviceId;
        if (!existing || (isMain && existing.isSubDevice)) {
          rowsByPhysicalDevice.set(physicalId, {
            ...row,
            isSubDevice: Boolean(data.subDeviceId),
          });
        }
      }
    }

    return Array.from(rowsByPhysicalDevice.values())
      .map(({ isSubDevice, ...row }) => row);
  },

  async resetMessageStats({ homey }) {
    const managers = new Set();
    const drivers = homey.drivers.getDrivers();

    for (const driver of Object.values(drivers)) {
      for (const device of driver.getDevices()) {
        const manager = device._availability;
        if (manager && typeof manager.resetMessageStats === 'function') {
          managers.add(manager);
        }
      }
    }

    const results = await Promise.allSettled(
      Array.from(managers, manager => manager.resetMessageStats()),
    );
    const failures = results.filter(result => result.status === 'rejected');

    if (failures.length > 0) {
      throw new Error(
        `Failed to reset ${failures.length} of ${results.length} statistics counters`,
      );
    }

    return { reset: results.length };
  },
};
