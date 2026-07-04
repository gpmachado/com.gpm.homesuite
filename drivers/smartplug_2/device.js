'use strict';

/**
 * Diagnostic driver for the TS011F / _TZ3210_fgwhjm9j variant.
 *
 * This device reports electrical measurements much more frequently than the
 * _TZ3000_okaz9tjs variant. Keep it separate from the stable smartplug driver
 * while collecting evidence about passive reports versus polling responses.
 */

const SmartPlugDevice = require('../smartplug/device');

const SUMMARY_INTERVAL_MS = 60 * 1000;
const REDUCED_REPORTING = {
  activePower: { minInterval: 30, maxInterval: 300, minChange: 5 },
  rmsCurrent: { minInterval: 30, maxInterval: 300, minChange: 50 },
  rmsVoltage: { minInterval: 60, maxInterval: 600, minChange: 2 },
  currentSummationDelivered: {
    minInterval: 60,
    maxInterval: 900,
    minChange: 1,
  },
};

const COMMAND_NAMES = {
  0x00: 'readAttributes',
  0x01: 'readAttributesResponse',
  0x06: 'configureReporting',
  0x07: 'configureReportingResponse',
  0x08: 'readReportingConfiguration',
  0x09: 'readReportingConfigurationResponse',
  0x0A: 'reportAttributes',
  0x0B: 'defaultResponse',
};

class SmartPlug2Device extends SmartPlugDevice {

  get diagnosticTag() {
    return 'SP2';
  }

  get diagnosticManufacturer() {
    return '_TZ3210_fgwhjm9j';
  }

  constructor(...args) {
    super(...args);
    this._debugFrameHookInstalled = false;
    this._debugFrameCounts = new Map();
    this._debugLastFrameAt = new Map();
    this._debugSummaryTimer = null;
    this._debugFramesEnabled = true;
    this._debugRawPayload = true;
  }

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this._debugFramesEnabled = this.getSetting('debug_frames') !== false;
    this._debugRawPayload = this.getSetting('debug_raw_payload') !== false;

    await this._installDiagnosticFrameHook();
    this._scheduleDebugSummary();

    this.homey.setTimeout(() => {
      this._readReportingConfigurationSnapshot().catch(err => {
        this.error(`[${this.diagnosticTag} reporting] Snapshot failed:`, err.message);
      });
    }, 3000);

    this.log(
      `[${this.diagnosticTag} debug] enabled=${this._debugFramesEnabled} `
      + `raw=${this._debugRawPayload} manufacturer=${this.diagnosticManufacturer}`,
    );
  }

  async onSettings(args) {
    await super.onSettings(args);

    const { newSettings, changedKeys } = args;
    if (changedKeys.includes('debug_frames')) {
      this._debugFramesEnabled = newSettings.debug_frames !== false;
    }
    if (changedKeys.includes('debug_raw_payload')) {
      this._debugRawPayload = newSettings.debug_raw_payload !== false;
    }
    if (
      changedKeys.includes('debug_frames')
      || changedKeys.includes('debug_raw_payload')
    ) {
      this.log(
        `[${this.diagnosticTag} debug] settings enabled=${this._debugFramesEnabled} `
        + `raw=${this._debugRawPayload}`,
      );
    }
  }

  /**
   * Keep the standard on/off reporting and replace only this variant's noisy
   * electrical reporting. The read-back snapshot below verifies what the
   * firmware actually accepted instead of trusting configureReporting alone.
   */
  async _safeSetupAttributeReporting() {
    await super._safeSetupAttributeReporting();

    const endpoint = this.zclNode.endpoints[1];

    try {
      await endpoint.clusters.electricalMeasurement.configureReporting({
        activePower: REDUCED_REPORTING.activePower,
        rmsCurrent: REDUCED_REPORTING.rmsCurrent,
        rmsVoltage: REDUCED_REPORTING.rmsVoltage,
      });
      this.log(
        `[${this.diagnosticTag} reporting] electricalMeasurement configure accepted: `
        + JSON.stringify({
          activePower: REDUCED_REPORTING.activePower,
          rmsCurrent: REDUCED_REPORTING.rmsCurrent,
          rmsVoltage: REDUCED_REPORTING.rmsVoltage,
        }),
      );
    } catch (err) {
      this.log(
        `[${this.diagnosticTag} reporting] electricalMeasurement configure failed (${err.message})`,
      );
    }

    try {
      await endpoint.clusters.metering.configureReporting({
        currentSummationDelivered:
          REDUCED_REPORTING.currentSummationDelivered,
      });
      this.log(
        `[${this.diagnosticTag} reporting] metering configure accepted: `
        + JSON.stringify({
          currentSummationDelivered:
            REDUCED_REPORTING.currentSummationDelivered,
        }),
      );
    } catch (err) {
      this.log(`[${this.diagnosticTag} reporting] metering configure failed (${err.message})`);
    }
  }

  async _installDiagnosticFrameHook() {
    if (this._debugFrameHookInstalled) return;

    const node = await this.homey.zigbee.getNode(this);
    const previousHandleFrame = node.handleFrame.bind(node);

    node.handleFrame = (...args) => {
      try {
        this._recordDiagnosticFrame(...args);
      } catch (err) {
        this.error(`[${this.diagnosticTag} debug] frame parser:`, err.message);
      }
      return previousHandleFrame(...args);
    };

    this._debugFrameHookInstalled = true;
    this.log(`[${this.diagnosticTag} debug] raw frame hook installed`);
  }

  _recordDiagnosticFrame(endpointId, clusterId, frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 3) return;

    const frameControl = frame[0];
    const frameType = frameControl & 0x03;
    const manufacturerSpecific = Boolean(frameControl & 0x04);
    const commandIndex = manufacturerSpecific ? 4 : 2;
    const sequenceIndex = manufacturerSpecific ? 3 : 1;
    if (frame.length <= commandIndex) return;

    const commandId = frame[commandIndex];
    const sequence = frame[sequenceIndex];
    const clusterHex = `0x${Number(clusterId).toString(16).padStart(4, '0')}`;
    const commandHex = `0x${commandId.toString(16).padStart(2, '0')}`;
    const commandName = frameType === 0
      ? (COMMAND_NAMES[commandId] || 'globalCommand')
      : 'clusterCommand';
    const key = `${clusterHex}/${commandHex}`;
    const now = Date.now();
    const previousAt = this._debugLastFrameAt.get(key);
    const delta = previousAt == null ? '-' : `${now - previousAt}ms`;

    this._debugLastFrameAt.set(key, now);
    this._debugFrameCounts.set(key, (this._debugFrameCounts.get(key) || 0) + 1);

    if (!this._debugFramesEnabled) return;

    const raw = this._debugRawPayload ? ` raw=${frame.toString('hex')}` : '';
    this.log(
      `[${this.diagnosticTag} frame] ep=${endpointId} cluster=${clusterHex} `
      + `cmd=${commandName}(${commandHex}) seq=${sequence} `
      + `type=${frameType === 0 ? 'global' : 'cluster'} `
      + `delta=${delta} polling=${this._isPolling} len=${frame.length}${raw}`,
    );
  }

  _scheduleDebugSummary() {
    if (this._debugSummaryTimer) {
      this.homey.clearTimeout(this._debugSummaryTimer);
    }
    this._debugSummaryTimer = this.homey.setTimeout(() => {
      const counts = [...this._debugFrameCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => `${key}=${count}`)
        .join(' ');
      this.log(`[${this.diagnosticTag} summary/60s] ${counts || 'no frames'}`);
      this._debugFrameCounts.clear();
      this._scheduleDebugSummary();
    }, SUMMARY_INTERVAL_MS);
  }

  async _readReportingConfigurationSnapshot() {
    const endpoint = this.zclNode.endpoints[1];
    const targets = [
      {
        name: 'onOff',
        cluster: endpoint.clusters.onOff,
        attributes: ['onOff'],
      },
      {
        name: 'electricalMeasurement',
        cluster: endpoint.clusters.electricalMeasurement,
        attributes: ['activePower', 'rmsCurrent', 'rmsVoltage'],
      },
      {
        name: 'metering',
        cluster: endpoint.clusters.metering,
        attributes: ['currentSummationDelivered'],
      },
    ];

    for (const { name, cluster, attributes } of targets) {
      if (!cluster) {
        this.log(`[${this.diagnosticTag} reporting] ${name}: cluster unavailable`);
        continue;
      }
      try {
        const result = await cluster.readReportingConfiguration(attributes);
        this.log(`[${this.diagnosticTag} reporting] ${name}: ${JSON.stringify(result)}`);
      } catch (err) {
        this.log(`[${this.diagnosticTag} reporting] ${name}: read failed (${err.message})`);
      }
    }
  }

  async _pollCycle() {
    const startedAt = Date.now();
    this.log(`[${this.diagnosticTag} poll] start cycle=${this._pollCycleCount + 1}`);
    await super._pollCycle();
    this.log(`[${this.diagnosticTag} poll] end duration=${Date.now() - startedAt}ms`);
  }

  async _teardown() {
    if (this._debugSummaryTimer) {
      this.homey.clearTimeout(this._debugSummaryTimer);
      this._debugSummaryTimer = null;
    }
    this._debugFrameCounts.clear();
    this._debugLastFrameAt.clear();
    await super._teardown();
  }
}

module.exports = SmartPlug2Device;
