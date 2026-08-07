'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const SonoffCluster = require('../../lib/SonoffCluster');
const { CLUSTER } = require('zigbee-clusters');
const { SonoffTimeSilentBoundCluster } = require('../../lib/TimeCluster');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { SMART_PLUG_TIMEOUT_MS } = require('../../lib/constants');
const { BoundCluster } = require('zigbee-clusters');

// Handles device→hub cluster-specific commands on SonoffCluster (0xFC11).
// The MINI-ZB1GP energy meter sends cmdId 3 (status/heartbeat) and cmdId 1
// (protocolData responses) to the hub. Without a BoundCluster, these cause
// "binding_unavailable" errors every ~800ms.
class SonoffEnergyMeterBoundCluster extends BoundCluster {
  constructor(device) {
    super();
    this._device = device;
  }

  // cmdId 3 — device status/heartbeat (sent periodically with incrementing seq)
  statusReport(/* payload */) {}

  // cmdId 1 — protocolData response (e.g. inching ACK)
  protocolData(/* payload */) {}
}

class SonoffMINIZB1GP extends SonoffBase {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode }, { noAttribCheck: true });
    this.log(`[MINI-ZB1GP] ${this.getName()} initialized`);

    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: SMART_PLUG_TIMEOUT_MS,
    });
    await this._availability.install();

    // Standard capabilities via electricalMeasurement — device returns 0xFFFF
    // but configuring reporting wakes it up periodically so SonoffCluster reports flow.
    this._registerStandardCapabilities();

    // Sonoff-specific settings via custom cluster
    this._registerSonoffListeners();

    // Intercept SonoffCluster (0xFC11) reportAttributes frames before the framework's
    // auto-parser runs. The auto-parser fails on type mismatches for Sonoff's custom
    // attribute format, preventing the attr.* events from firing.
    this._installSonoffReportInterceptor();

    // Suppress Time cluster (0x000A) binding_unavailable errors
    this.zclNode.endpoints[1].bind('time', new SonoffTimeSilentBoundCluster());

    // Suppress SonoffCluster (0xFC11) binding_unavailable errors.
    // Device sends clusterSpecific commands (cmdId 3=status, cmdId 1=protocolData)
    // that have no BoundCluster handler.
    this.zclNode.endpoints[1].bind(SonoffCluster.NAME, new SonoffEnergyMeterBoundCluster(this));

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

    // Energy (kWh) - metering cluster (reported in Wh, convert to kWh)
    this.registerCapability('meter_power', CLUSTER.METERING, {
      reportParser: value => (this._isValidEnergy(value) ? value / 1000 : null),
      getParser: value => (this._isValidEnergy(value) ? value / 1000 : null),
      getOpts: { getOnStart: true, getOnOnline: true, pollInterval: 300000 },
      reportOpts: {
        configureAttributeReporting: {
          minInterval: 60,
          maxInterval: 300,
          minChange: 1, // 1Wh change
        },
      },
    });
  }

  _isValidEnergy(value) {
    return Number.isFinite(value) && value >= 0 && value !== 65535 && value !== 4294967295;
  }

  _isValidReading(value) {
    return Number.isFinite(value) && value >= 0 && value !== 65535 && value !== 4294967295;
  }

  _registerSonoffListeners() {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];

    // Network LED setting
    cluster.on('attr.network_led', value => {
      this.setSettings({ network_led: Boolean(value) }).catch(() => {});
    });

    // Turbo Mode setting
    cluster.on('attr.TurboMode', value => {
      this.setSettings({ TurboMode: Number(value) === 20 }).catch(() => {});
    });

    // Energy data from SonoffCluster
    cluster.on('attr.acCurrentVoltageValue', value => {
      if (this._isValidReading(value)) this.setCapabilityValue('measure_voltage', value / 1000).catch(this.error);
    });

    cluster.on('attr.acCurrentPowerValue', value => {
      const watts = (value > 0x7fffffff ? value - 0x100000000 : value) / 1000;
      if (this._isValidReading(watts)) this.setCapabilityValue('measure_power', watts).catch(this.error);
    });

    cluster.on('attr.acCurrentCurrentValue', value => {
      if (this._isValidReading(value)) this.setCapabilityValue('measure_current', value / 1000).catch(this.error);
    });
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
          ['acCurrentVoltageValue', 'acCurrentPowerValue', 'acCurrentCurrentValue'],
          { manufacturerCode: 0x1286 }
        );
        this.log('[MINI-ZB1GP] SonoffCluster energy (mfr):', energy);
        if (energy.acCurrentVoltageValue !== undefined && this._isValidReading(energy.acCurrentVoltageValue)) {
          this.setCapabilityValue('measure_voltage', energy.acCurrentVoltageValue / 1000).catch(() => {});
        }
        if (energy.acCurrentPowerValue !== undefined) {
          const watts = (energy.acCurrentPowerValue > 0x7fffffff ? energy.acCurrentPowerValue - 0x100000000 : energy.acCurrentPowerValue) / 1000;
          if (this._isValidReading(watts)) this.setCapabilityValue('measure_power', watts).catch(() => {});
        }
        if (energy.acCurrentCurrentValue !== undefined && this._isValidReading(energy.acCurrentCurrentValue)) {
          this.setCapabilityValue('measure_current', energy.acCurrentCurrentValue / 1000).catch(() => {});
        }
      } catch (e) {
        this.log('[MINI-ZB1GP] mfr read failed:', e.message);
      }
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
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

  /**
   * Intercept raw SonoffCluster (0xFC11) reportAttributes frames.
   * The zigbee-clusters auto-parser fails on type mismatches, preventing attr.* events.
   * This parses the buffer manually and emits the events on the cluster.
   */
  _installSonoffReportInterceptor() {
    const endpoint = this.zclNode.endpoints[1];
    const cluster = endpoint.clusters[SonoffCluster.NAME];
    if (!cluster) return;

    const ATTRS = SonoffCluster.ATTRIBUTES;
    const ATTR_MAP = {};
    for (const [name, def] of Object.entries(ATTRS)) {
      ATTR_MAP[def.id] = { name, type: def.type };
    }

    const TYPE_SIZES = {
      0x10: 1, 0x18: 1, 0x20: 1, 0x21: 2, 0x23: 4,
      0x28: 1, 0x29: 2, 0x2B: 4, 0x1B: 4,
    };

    const readValue = (buf, offset, typeId) => {
      switch (typeId) {
        case 0x10: return buf.readUInt8(offset) === 1;
        case 0x20: return buf.readUInt8(offset);
        case 0x21: return buf.readUInt16LE(offset);
        case 0x23: return buf.readUInt32LE(offset);
        case 0x28: return buf.readInt8(offset);
        case 0x29: return buf.readInt16LE(offset);
        case 0x2B: return buf.readInt32LE(offset);
        case 0x18: return buf.readUInt8(offset);
        case 0x1B: return buf.readUInt32LE(offset);
        default:   return buf.readUInt16LE(offset);
      }
    };

    const hook = this.node.handleFrame.bind(this.node);
    this.node.handleFrame = (...args) => {
      const [, clusterId, frame] = args;
      if (clusterId === SonoffCluster.ID && Buffer.isBuffer(frame) && frame.length >= 2) {
        const cmdId = frame[0];
        if (cmdId === 0x0A) { // reportAttributes
          this._availability?.notifyActivity('SonoffCluster');
          const data = frame.slice(1);
          let offset = 0;
          while (offset + 3 <= data.length) {
            const attrId = data.readUInt16LE(offset);
            offset += 2;
            const typeId = data[offset++];
            const attr = ATTR_MAP[attrId];
            const size = TYPE_SIZES[typeId] || 2;
            if (offset + size > data.length) break;
            if (attr) {
              const value = readValue(data, offset, typeId);
              cluster.emit(`attr.${attr.name}`, value);
            }
            offset += size;
          }
          return Promise.resolve(); // skip framework auto-parser
        }
        // Suppress device→hub cluster-specific commands (cmdId 1=protocolData, 3=status)
        // that have no BoundCluster handler and cause binding_unavailable errors
        if (cmdId === 0x01 || cmdId === 0x03) {
          return Promise.resolve();
        }
      }
      return hook(...args);
    };
  }

  async onDeleted() {
    this.log('[MINI-ZB1GP] removed');
    await this._teardown();
  }

}

module.exports = SonoffMINIZB1GP;
