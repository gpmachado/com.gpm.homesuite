'use strict';

const SonoffCluster = require('../../lib/SonoffCluster');
const { Cluster, CLUSTER, BoundCluster } = require('zigbee-clusters');
const SonoffBase = require('../../lib/SonoffBase');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
const { SONOFF_HEARTBEAT_TIMEOUT_MS, SONOFF_REPORT_MAX_INTERVAL_S } = require('../../lib/constants');

// Handles external switch commands (detach_mode) sent directly to the hub
class MyOnOffBoundCluster extends BoundCluster {
    constructor(device) {
        super();
        this._device = device;
        this._click = device.homey.flow.getDeviceTriggerCard("ZBMINIR2:click");
    }
    toggle() {
        this._click.trigger(this._device, {}, {}).catch(this._device.error);
    }
    setOn() {
        this._device.setCapabilityValue('onoff', true).catch(this._device.error);
    }
    setOff() {
        this._device.setCapabilityValue('onoff', false).catch(this._device.error);
    }
    onWithTimedOff({ onOffControl, onTime, offWaitTime }) {
        this._device.log('onWithTimedOff received', { onOffControl, onTime, offWaitTime });
    }
    offWithEffect() {
        this._device.setCapabilityValue('onoff', false).catch(this._device.error);
    }
}

const SonoffClusterAttributes = [
    'TurboMode',
    'network_led',
    'power_on_delay_state',
    'power_on_delay_time',
    'switch_mode',
    'detach_mode'
];

const INCHING_PROTOCOL = {
    CMD:             0x01,
    SUBCMD_INCHING:  0x17,
    PAYLOAD_LENGTH:  0x07,
    SEQ_NUM:         0x80,
    FLAG_ENABLE:     0x80,
    FLAG_MODE_ON:    0x01,
};

class SonoffZBMINIR2 extends SonoffBase {

    async onNodeInit({ zclNode }) {

        super.onNodeInit({ zclNode });

        if (this.hasCapability('onoff')) {
            // The ZBMINI-R2 firmware doesn't send a ZCL Default Response to setOn/setOff.
            // registerCapability uses the SDK's default which waits 10 s → "Timeout: Expected Response".
            // Instead, wire the capability manually:
            //   - SET:    registerCapabilityListener with waitForResponse: false (fire-and-forget)
            //   - REPORT: cluster attr.onOff event → setCapabilityValue
            const _onOffCluster = zclNode.endpoints[1].clusters.onOff;

            _onOffCluster.on('attr.onOff', value => {
                this.log(`handle report (cluster: onOff, capability: onoff), parsed payload: ${value}`);
                this.setCapabilityValue('onoff', value).catch(this.error);
            });

            this.registerCapabilityListener('onoff', async value => {
                this.log(`set onoff → ${value} (cluster: onOff, endpoint: 1)`);
                if (value) {
                    return _onOffCluster.setOn({}, { waitForResponse: false });
                }
                return _onOffCluster.setOff({}, { waitForResponse: false });
            });
        }

        // Availability tracking — install FIRST so ZCL responses during init reads
        // (configureReporting, checkAttributes) update last_seen_ts.
        this._availability = new AvailabilityManagerCluster0(this, { timeout: SONOFF_HEARTBEAT_TIMEOUT_MS });
        await this._availability.install();

        // Deferred 30 s: mesh routes are stale immediately after boot.
        // Firing configureAttributeReporting before the route is established generates
        // [err] stack traces from homey-zigbeedriver's executeMethod — harmless but noisy.
        // onBecameAvailable() retries after power-cycle / rejoin.
        this.homey.setTimeout(() => {
            if (!this.zclNode) return;
            this.zclNode.endpoints[1].clusters.onOff.configureReporting({
                onOff: { minInterval: 0, maxInterval: SONOFF_REPORT_MAX_INTERVAL_S, minChange: 1 },
            }).catch(err => this.log('[Reporting] boot config failed:', err.message));
        }, 30_000);

        this.zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, new MyOnOffBoundCluster(this));

        // Unified handleFrame hook (node-level: frame is a raw Buffer, not a parsed object).
        //   ZCL frame layout (non-manufacturer-specific): [frameCtrl, seqNum, cmdId, ...payload]
        //   ZCL frame layout (manufacturer-specific):     [frameCtrl, mfrLo, mfrHi, seqNum, cmdId, ...payload]
        //   Bit 2 of frameCtrl = manufacturer-specific flag.
        //
        //   1. Filter Sonoff ACK frames (cmdId 0x0B, mfr-specific) that zigbee-clusters can't route
        //      via BoundCluster. Covers: SonoffCluster inching ACK and stray defaultResponse on onOff.
        //   2. Rejoin detection: SonoffCluster reportAttributes (cmdId 0x0A, global/non-mfr-specific)
        //      fires on power restore. Guard: skip if settings written < 30s ago.
        this._startedAt = Date.now();
        {
            const _hook = this.node.handleFrame.bind(this.node);
            this.node.handleFrame = (...args) => {
                const [, clusterId, frame] = args;
                const _now = Date.now();
                if (Buffer.isBuffer(frame) && frame.length >= 3) {
                    const mfrSpecific = frame[0] & 0x04;
                    const cmdId = mfrSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
                    // 1. Drop Sonoff manufacturer ACK (0x0B) — prevents unknown_command_received errors
                    if (cmdId === 0x0B && (clusterId === SonoffCluster.ID || clusterId === 6)) return Promise.resolve();
                    // 2. Detect SonoffCluster attribute reports (0x0A, global) as rejoin signal
                    if (cmdId === 0x0A && !mfrSpecific && clusterId === SonoffCluster.ID) {
                        if (_now - (this._lastSonoffWriteAt ?? 0) >= 30_000) {
                            this._notifyRejoin();
                        }
                    }
                }
                return _hook(...args);
            };
        }

        this.log('ZBMINIR2 initialized');
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        if (changedKeys.includes("power_on_behavior")) {
            try {
                await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({ powerOnBehavior: newSettings.power_on_behavior });
            } catch (error) {
                this.log("Error updating the power on behavior");
            }
        }

        // Convert TurboMode boolean checkbox → int16 expected by device (20=on, 9=off)
        // Convert power_on_delay_time from seconds (UI) to 0.5s units for wire (scale: 2)
        const settingsToWrite = { ...newSettings };
        if (settingsToWrite.TurboMode !== undefined) {
            settingsToWrite.TurboMode = settingsToWrite.TurboMode ? 20 : 9;
        }
        if (settingsToWrite.power_on_delay_time !== undefined) {
            settingsToWrite.power_on_delay_time = Math.round(settingsToWrite.power_on_delay_time * 2);
        }
        // switch_mode is stored as string (dropdown) but firmware expects integer
        if (settingsToWrite.switch_mode !== undefined) {
            settingsToWrite.switch_mode = Number(settingsToWrite.switch_mode);
        }
        this._lastSonoffWriteAt = Date.now();
        this.writeAttributes(SonoffCluster, settingsToWrite, changedKeys).catch(this.error);

        // Handle inching settings changes
        const inchingKeys = ['inching_enabled', 'inching_mode', 'inching_time'];
        const inchingChanged = changedKeys.some(key => inchingKeys.includes(key));

        if (inchingChanged) {
            try {
                await this.setInching(
                    newSettings.inching_enabled,
                    newSettings.inching_time,
                    newSettings.inching_mode
                );
                this.log('Inching settings updated:', {
                    enabled: newSettings.inching_enabled,
                    mode: newSettings.inching_mode,
                    time: newSettings.inching_time
                });
            } catch (error) {
                this.error('Error updating inching settings:', error);
                throw new Error('Failed to update inching settings');
            }
        }
    }

    /**
     * Set inching (auto-off/on) configuration
     * @param {boolean} enabled - Enable or disable inching
     * @param {number} time - Time in seconds (0.1-3600)
     * @param {string} mode - 'on' (turn ON then OFF) or 'off' (turn OFF then ON)
     */
    async setInching(enabled = false, time = 1, mode = 'on') {
        if (typeof enabled !== 'boolean') throw new TypeError(`enabled must be boolean, got ${typeof enabled}`);
        if (typeof time !== 'number' || time < 0 || time > 32767.5) throw new RangeError(`time must be 0–32767.5 s, got ${time}`);
        if (!['on', 'off'].includes(mode)) throw new TypeError(`mode must be "on" or "off", got "${mode}"`);

        try {
            const tmpTime = Math.min(Math.max(Math.round(time * 2000 / 1000), 1), 0xffff);

            const payloadValue = [
                INCHING_PROTOCOL.CMD,
                INCHING_PROTOCOL.SUBCMD_INCHING,
                INCHING_PROTOCOL.PAYLOAD_LENGTH,
                INCHING_PROTOCOL.SEQ_NUM,
                (enabled ? INCHING_PROTOCOL.FLAG_ENABLE : 0) | (mode === 'on' ? INCHING_PROTOCOL.FLAG_MODE_ON : 0),
                0x00,
                tmpTime & 0xff,
                (tmpTime >> 8) & 0xff,
                0x00,
                0x00,
                0x00,
            ];
            payloadValue[10] = this._calculateChecksum(payloadValue, INCHING_PROTOCOL.PAYLOAD_LENGTH + 3);

            this.log('Sending inching command:', { enabled, mode, time_s: time, time_half_s: tmpTime });

            const cluster = this.zclNode.endpoints[1].clusters['SonoffCluster'];
            await cluster.protocolData(
                { data: Buffer.from(payloadValue) },
                { disableDefaultResponse: true, waitForResponse: false }
            );
            this.log('Inching command sent successfully');
        } catch (error) {
            this.error('Failed to set inching:', error);
            throw error;
        }
    }

    _calculateChecksum(payload, length) {
        let checksum = 0x00;
        for (let i = 0; i < length; i++) checksum ^= payload[i];
        return checksum;
    }

    /**
     * Fires the device_rejoined flow trigger.
     * Guards: 120s post-startup (ignores boot dump) + 30s cooldown (burst dedup).
     */
    _notifyRejoin() {
        const now = Date.now();
        if ((now - (this._startedAt ?? 0)) < 120_000) return;   // boot guard
        if ((now - (this._lastRejoinTs ?? 0)) < 30_000) return;  // burst cooldown
        this._lastRejoinTs = now;
        this.onDeviceRejoin();
    }

    onDeviceRejoin() {
        this.log('Device rejoined');
        const AvailabilityManager = require('../../lib/AvailabilityManager');
        AvailabilityManager.triggerRejoin(this, 0, 'ZBMINIR2:device_rejoined');
    }

    // ZDO Device Announce — logged for visibility only, NOT used as a rejoin signal.
    // A routing/mesh re-attach also sends a bare announce (no reboot), which caused
    // false device_rejoined triggers (announce ~20 min after init, no power cut).
    // The real power-restore signal is the SonoffCluster attribute boot dump
    // (cmdId 0x0A) handled in the handleFrame hook — a routing announce never
    // produces it. So rejoin fires there, not here.
    onEndDeviceAnnounce() {
        this.log('ZDO Device Announce (rejoin fires on the SonoffCluster boot dump, not here)');
    }

    async checkAttributes() {
        this.readAttribute(CLUSTER.ON_OFF, ['powerOnBehavior'], (data) => {
            this.setSettings({ power_on_behavior: data.powerOnBehavior }).catch(this.error);
        });

        this.readAttribute(SonoffCluster, SonoffClusterAttributes, (data) => {
            if (!data) return;
            const settingsData = {};
            if (data.TurboMode !== undefined)          settingsData.TurboMode            = data.TurboMode === 20;
            if (data.network_led !== undefined)        settingsData.network_led          = Boolean(data.network_led);
            if (data.power_on_delay_state !== undefined) settingsData.power_on_delay_state = Boolean(data.power_on_delay_state);
            if (data.power_on_delay_time !== undefined) settingsData.power_on_delay_time  = data.power_on_delay_time / 2;
            if (data.switch_mode !== undefined)        settingsData.switch_mode          = String(data.switch_mode);
            if (data.detach_mode !== undefined)        settingsData.detach_mode          = Boolean(data.detach_mode);
            if (Object.keys(settingsData).length) this.setSettings(settingsData).catch(this.error);
        });
    }

    async onBecameAvailable() {
        this.log('Device became available');
        if (super.onBecameAvailable) await super.onBecameAvailable();
        // AvailabilityManager._markAllAvailable already fires the flow trigger.
    }

    async onBecameUnavailable(reason) {
        this.log(`Device became unavailable (${reason})`);
        if (super.onBecameUnavailable) await super.onBecameUnavailable(reason);
        // AvailabilityManager._markAllUnavailable already fires the flow trigger.
    }

    async onDeleted() {
        this.log('ZBMINIR2 removed');
        await this._availability?.uninstall().catch(() => {});
    }

}

module.exports = SonoffZBMINIR2;
