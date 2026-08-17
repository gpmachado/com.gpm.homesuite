'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const SonoffCluster = require('../../lib/SonoffCluster');
const { CLUSTER } = require('zigbee-clusters');
const { SonoffTimeServerBoundCluster } = require('../../lib/TimeCluster');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_FAST_MS } = require('../../lib/constants');

/**
 * SonoffMINIZB1GP — driver for the Sonoff MINI-ZB1GP energy meter.
 *
 * The device's SonoffCluster (0xFC11) reportAttributes frames use a wire format
 * the zigbee-clusters auto-parser can't decode (type mismatches), so this driver
 * intercepts raw frames at the node level and parses them manually — see
 * {@link SonoffBase#_installClusterReportInterceptor}.
 */
class SonoffMINIZB1GP extends SonoffBase {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode }, { noAttribCheck: true });
    this.log(`[MINI-ZB1GP] ${this.getName()} initialized`);

    this._availability = new AvailabilityManagerPassive(this, {
      timeout: HEARTBEAT_FAST_MS,
    });
    await this._availability.install();

    // Standard capabilities via electricalMeasurement — device returns 0xFFFF
    // but configuring reporting wakes it up periodically so SonoffCluster reports flow.
    this._registerStandardCapabilities();

    // Sonoff-specific settings via custom cluster
    this._registerSonoffListeners();

    // Intercept SonoffCluster (0xFC11) reportAttributes frames before the framework's
    // auto-parser runs. The auto-parser fails on type mismatches for Sonoff's custom
    // attribute format, preventing the attr.* events from firing. This same hook also
    // suppresses cmdId 1/3 clusterSpecific commands that have no BoundCluster handler
    // and would otherwise log "binding_unavailable" errors.
    this._installClusterReportInterceptor(SonoffCluster, { suppressCmdIds: [0x01, 0x03] });

    // Suppress Time cluster (0x000A) binding_unavailable errors
    this.zclNode.endpoints[1].bind('time', new SonoffTimeServerBoundCluster());

    // Read initial data
    await this.checkAttributes();

    this.log('[MINI-ZB1GP] energy meter driver ready');
  }

  _registerStandardCapabilities() {
    // Active Power (W) - electricalMeasurement cluster
    this.registerCapability('measure_power', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: value => (this._isValidReading(value) ? value : null),
      getParser: value => (this._isValidReading(value) ? value : null),
      getOpts: { getOnStart: true, getOnOnline: true, pollInterval: 300000 },
      reportOpts: {
        configureAttributeReporting: {
          minInterval: 10,
          maxInterval: 300,
          minChange: 10, // 10W change
        },
      },
    });

    // Current (A) - electricalMeasurement cluster (reported in mA, convert to A)
    this.registerCapability('measure_current', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: value => (this._isValidReading(value) ? value / 1000 : null),
      getParser: value => (this._isValidReading(value) ? value / 1000 : null),
      getOpts: { getOnStart: true, getOnOnline: true, pollInterval: 300000 },
      reportOpts: {
        configureAttributeReporting: {
          minInterval: 10,
          maxInterval: 300,
          minChange: 100, // 100mA = 0.1A change
        },
      },
    });

    // Voltage (V) - electricalMeasurement cluster (reported in 0.1V)
    this.registerCapability('measure_voltage', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: value => (this._isValidReading(value) ? value / 10 : null),
      getParser: value => (this._isValidReading(value) ? value / 10 : null),
      getOpts: { getOnStart: true, getOnOnline: true, pollInterval: 300000 },
      reportOpts: {
        configureAttributeReporting: {
          minInterval: 60,
          maxInterval: 300,
          minChange: 50, // 5V change
        },
      },
    });

    // Energy (kWh) - Sonoff custom cluster (reported in Wh, convert to kWh)
    this.registerCapability('meter_power', SonoffCluster, {
      get: 'totalEnergyConsumption',
      report: 'totalEnergyConsumption',
      reportParser: value => (this._isValidReading(value) ? value / 1000 : null),
      getParser: value => (this._isValidReading(value) ? value / 1000 : null),
      getOpts: { getOnStart: true, getOnOnline: true, pollInterval: 300000 },
      reportOpts: {
        configureAttributeReporting: {
          minInterval: 60,
          maxInterval: 120, // was 300s — observed ~5min lag on real hardware, testing 2min
          minChange: 1, // 1Wh change
        },
      },
    });
  }

  /**
   * Reject the device's sentinel "no reading" values.
   * Used for every electricalMeasurement/energy attribute this driver reads —
   * they all share the same 16-/32-bit "unset" sentinels.
   * @param {number} value - Raw or converted numeric reading.
   * @returns {boolean} True if the reading is usable.
   */
  _isValidReading(value) {
    return Number.isFinite(value) && value >= 0 && value !== 65535 && value !== 4294967295;
  }

  // _toSignedInt32 is inherited from SonoffBase.

  _registerSonoffListeners() {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];

    // Stable references so remove-then-add guards against duplicate
    // accumulation if onNodeInit runs again on a reused cluster object.
    this._onNetworkLed ??= value => {
      this.setSettings({ network_led: Boolean(value) }).catch(() => {});
    };
    this._onTurboMode ??= value => {
      this.setSettings({ TurboMode: Number(value) === 20 }).catch(() => {});
    };
    this._onAcVoltage ??= value => {
      if (this._isValidReading(value)) this.setCapabilityValue('measure_voltage', value / 1000).catch(this.error);
    };
    this._onAcPower ??= value => {
      const watts = this._toSignedInt32(value) / 1000;
      if (this._isValidReading(watts)) this.setCapabilityValue('measure_power', watts).catch(this.error);
    };
    this._onAcCurrent ??= value => {
      if (this._isValidReading(value)) this.setCapabilityValue('measure_current', value / 1000).catch(this.error);
    };
    this._onTotalEnergy ??= value => {
      if (this._isValidReading(value)) this.setCapabilityValue('meter_power', value / 1000).catch(this.error);
    };

    cluster.removeListener('attr.network_led', this._onNetworkLed);
    cluster.on('attr.network_led', this._onNetworkLed);
    cluster.removeListener('attr.TurboMode', this._onTurboMode);
    cluster.on('attr.TurboMode', this._onTurboMode);
    cluster.removeListener('attr.acCurrentVoltageValue', this._onAcVoltage);
    cluster.on('attr.acCurrentVoltageValue', this._onAcVoltage);
    cluster.removeListener('attr.acCurrentPowerValue', this._onAcPower);
    cluster.on('attr.acCurrentPowerValue', this._onAcPower);
    cluster.removeListener('attr.acCurrentCurrentValue', this._onAcCurrent);
    cluster.on('attr.acCurrentCurrentValue', this._onAcCurrent);
    cluster.removeListener('attr.totalEnergyConsumption', this._onTotalEnergy);
    cluster.on('attr.totalEnergyConsumption', this._onTotalEnergy);
  }

  async checkAttributes() {
    // Settings reads (standard)
    await this.readAttribute(SonoffCluster, [
      'network_led',
      'TurboMode',
    ], (data) => {
      if (!data) return;
      const settings = {};
      if (data.network_led !== undefined) settings.network_led = Boolean(data.network_led);
      if (data.TurboMode !== undefined) settings.TurboMode = Number(data.TurboMode) === 20;
      if (Object.keys(settings).length) this.setSettings(settings).catch(this.error);
    });

    // Energy reads — manufacturer-specific (mfrCode 0x1286)
    // zigbee-clusters v2+ requires an array as first argument to readAttributes
    this.log('[MINI-ZB1GP] checkAttributes: attempting mfr read...');
    const sonoffCluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    if (sonoffCluster) {
      try {
        const energy = await sonoffCluster.readAttributes(
          ['acCurrentVoltageValue', 'acCurrentPowerValue', 'acCurrentCurrentValue', 'totalEnergyConsumption'],
          { manufacturerCode: 0x1286 }
        );
        this.log('[MINI-ZB1GP] SonoffCluster energy (mfr):', energy);
        if (energy.acCurrentVoltageValue !== undefined && this._isValidReading(energy.acCurrentVoltageValue)) {
          this.setCapabilityValue('measure_voltage', energy.acCurrentVoltageValue / 1000).catch(() => {});
        }
        if (energy.acCurrentPowerValue !== undefined) {
          const watts = this._toSignedInt32(energy.acCurrentPowerValue) / 1000;
          if (this._isValidReading(watts)) this.setCapabilityValue('measure_power', watts).catch(() => {});
        }
        if (energy.acCurrentCurrentValue !== undefined && this._isValidReading(energy.acCurrentCurrentValue)) {
          this.setCapabilityValue('measure_current', energy.acCurrentCurrentValue / 1000).catch(() => {});
        }
        if (energy.totalEnergyConsumption !== undefined && this._isValidReading(energy.totalEnergyConsumption)) {
          this.setCapabilityValue('meter_power', energy.totalEnergyConsumption / 1000).catch(() => {});
        }
      } catch (e) {
        this.log('[MINI-ZB1GP] mfr read failed:', e.message);
      }
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    const toWrite = {};

    if (changedKeys.includes('network_led')) {
      toWrite.network_led = Boolean(newSettings.network_led);
    }

    if (changedKeys.includes('TurboMode')) {
      toWrite.TurboMode = newSettings.TurboMode ? 20 : 9;
    }

    if (Object.keys(toWrite).length > 0) {
      await this.writeAttributes(SonoffCluster, toWrite);
    }
  }

  // reportAttributes parsing + binding_unavailable suppression for
  // SonoffCluster is handled by SonoffBase#_installClusterReportInterceptor.
  // cmdId 0x01 (protocolData) / 0x03 (status heartbeat) have no BoundCluster
  // handler; both are suppressed but cmdId 0x03 (the periodic heartbeat)
  // still counts as availability activity.

  /**
   * Reset the device's accumulated energy counter (totalEnergyConsumption).
   * cmdId 0x10, sniffer-confirmed (not manufacturer-specific), fixed 3-byte
   * payload. The device replies with a standard ZCL Default Response, which
   * confirms delivery but not the reset itself, so re-read the counter after
   * a short delay to verify it actually zeroed.
   */
  async _resetConsumption() {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    await cluster.resetConsumption({ data: Buffer.from([0x01, 0x01, 0x03]) });
    this.log('[MINI-ZB1GP] resetConsumption sent');

    await new Promise(r => this.homey.setTimeout(r, 2000));
    try {
      const result = await cluster.readAttributes(['totalEnergyConsumption'], { manufacturerCode: 0x1286 });
      this.log('[MINI-ZB1GP] totalEnergyConsumption after reset:', result.totalEnergyConsumption);
      if (result.totalEnergyConsumption !== undefined && this._isValidReading(result.totalEnergyConsumption)) {
        this.setCapabilityValue('meter_power', result.totalEnergyConsumption / 1000).catch(() => {});
      }
    } catch (e) {
      this.log('[MINI-ZB1GP] post-reset read failed:', e.message);
    }
  }

  async onDeleted() {
    this.log('[MINI-ZB1GP] removed');
    await this._teardown();
  }

}

module.exports = SonoffMINIZB1GP;
