'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const { CLUSTER } = require('zigbee-clusters');
const SonoffCluster = require('../../lib/SonoffCluster');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

const OccupancySensing = CLUSTER.OCCUPANCY_SENSING;

class SonoffSNZB06P extends SonoffBase {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: 12 * 60 * 60 * 1000,
      // The sensor can remain silent while the room is empty. Confirm that the
      // always-powered router still answers before marking it unavailable.
      pollBeforeOffline: true,
    });
    await this._availability.install();

    if (this.hasCapability('alarm_contact')) {
      await this.removeCapability('alarm_contact');
      await this.addCapability('alarm_motion');
    }

    const occCluster = zclNode.endpoints[1].clusters[OccupancySensing.NAME];
    const sonoffCluster = zclNode.endpoints[1].clusters[SonoffCluster.NAME];

    // Occupancy — reports spontaneously, no configureReporting needed
    this._onOccupancyReport ??= value => {
      this.log('[SNZB06P] occupancy:', value);
      this.setCapabilityValue('alarm_motion', Boolean(value?.occupied))
        .catch(error => this.error('[SNZB06P] occupancy update failed:', error.message));
    };
    occCluster.removeListener('attr.occupancy', this._onOccupancyReport);
    occCluster.on('attr.occupancy', this._onOccupancyReport);

    // Illuminance — only when occupied
    this._onIlluminanceReport ??= value => {
      this.log('[SNZB06P] illuminance:', value ? 'bright' : 'dim');
      this.setCapabilityValue('sonoff_illuminance', value ? 'bright' : 'dim')
        .catch(error => this.error('[SNZB06P] illumination update failed:', error.message));
    };
    sonoffCluster.removeListener('attr.illuminance', this._onIlluminanceReport);
    sonoffCluster.on('attr.illuminance', this._onIlluminanceReport);

    // Defer initial read until device wakes up (it reports on first occupancy)
    this._settingsReadTimer = this.homey.setTimeout(() => {
      this._readSettings().catch(error => {
        this.log('[SNZB06P] Initial settings read deferred:', error.message);
      });
    }, 5000);

    this.log(`[SNZB06P] initialized (firmware ${this.getSetting('zb_sw_build_id') || 'unknown'})`);
  }

  async _readSettings() {
    try {
      const occCluster = this.zclNode.endpoints[1].clusters[OccupancySensing.NAME];
      const data = await occCluster.readAttributes([
        'ultrasonicOccupiedToUnoccupiedDelay',
        'ultrasonicUnoccupiedToOccupiedThreshold',
      ]);
      this.log('[SNZB06P] read settings:', JSON.stringify(data));
      if (data.ultrasonicOccupiedToUnoccupiedDelay != null) {
        await this.setSettings({ occupied_to_unoccupied_delay: data.ultrasonicOccupiedToUnoccupiedDelay });
      }
      if (data.ultrasonicUnoccupiedToOccupiedThreshold != null) {
        await this.setSettings({ occupied_threshold: String(data.ultrasonicUnoccupiedToOccupiedThreshold) });
      }
    } catch (err) {
      this.log('[SNZB06P] Settings read deferred:', err.message);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    const writes = {};
    if (changedKeys.includes('occupied_to_unoccupied_delay')) {
      writes.ultrasonicOccupiedToUnoccupiedDelay = newSettings.occupied_to_unoccupied_delay;
    }
    if (changedKeys.includes('occupied_threshold')) {
      writes.ultrasonicUnoccupiedToOccupiedThreshold = Number(newSettings.occupied_threshold);
    }
    if (Object.keys(writes).length > 0) {
      await this.writeAttributes(OccupancySensing, writes);
      await this._readSettings();
    }
  }

  async _teardown() {
    if (this._settingsReadTimer) {
      this.homey.clearTimeout(this._settingsReadTimer);
      this._settingsReadTimer = null;
    }

    const endpoint = this.zclNode?.endpoints?.[1];
    endpoint?.clusters?.[OccupancySensing.NAME]
      ?.removeListener('attr.occupancy', this._onOccupancyReport);
    endpoint?.clusters?.[SonoffCluster.NAME]
      ?.removeListener('attr.illuminance', this._onIlluminanceReport);

    await super._teardown?.();
  }

}

module.exports = SonoffSNZB06P;
