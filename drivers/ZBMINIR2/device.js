'use strict';

const SonoffCluster = require('../../lib/SonoffCluster');
const { Cluster, CLUSTER, BoundCluster } = require('zigbee-clusters');
const SonoffBase = require('../../lib/SonoffBase');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
const { SONOFF_HEARTBEAT_TIMEOUT_MS } = require('../../lib/constants');

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

class SonoffZBMINIR2 extends SonoffBase {

    async onNodeInit({ zclNode }) {

        super.onNodeInit({ zclNode });

        if (this.hasCapability('onoff')) {
            this.registerCapability('onoff', CLUSTER.ON_OFF);
        }

        // Availability tracking — install FIRST so ZCL responses during init reads
        // (configureReporting, checkAttributes) update last_seen_ts.
        this._availability = new AvailabilityManagerCluster0(this, { timeout: SONOFF_HEARTBEAT_TIMEOUT_MS });
        await this._availability.install();

        this.configureAttributeReporting([
            {
                endpointId: 1,
                cluster: CLUSTER.ON_OFF,
                attributeName: 'onOff',
                minInterval: 0,
                maxInterval: 3600
            }
        ]).catch(this.error);

        this.zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, new MyOnOffBoundCluster(this));

        // Filter Sonoff inching ACK (cmdId 0x0B) before cluster dispatch.
        // This frame lacks clusterSpecific so zigbee-clusters can't route it via BoundCluster.
        {
            const _hook = this.node.handleFrame.bind(this.node);
            this.node.handleFrame = (...args) => {
                const [, clusterId, frame] = args;
                if (clusterId === SonoffCluster.ID && frame?.cmdId === 0x0B) return Promise.resolve();
                return _hook(...args);
            };
        }

        // checkAttributes only on first pairing or if settings are unpopulated.
        // Device stores all config in non-volatile memory — no need to re-read on every boot.
        if (this.isFirstInit() || !this.getSetting('switch_mode')) {
            this.checkAttributes();
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
        try {
            const msTime = Math.round(time * 1000);
            const rawTimeUnits = Math.round(msTime / 500);
            const tmpTime = Math.min(Math.max(rawTimeUnits, 1), 0xffff);

            const payloadValue = [];
            payloadValue[0] = 0x01;  // Cmd
            payloadValue[1] = 0x17;  // SubCmd - INCHING SUBCOMMAND
            payloadValue[2] = 0x07;  // Length (7 bytes of data follow)
            payloadValue[3] = 0x80;  // SeqNum

            payloadValue[4] = 0x00;
            if (enabled) payloadValue[4] |= 0x80;
            if (mode === 'on') payloadValue[4] |= 0x01;

            payloadValue[5] = 0x00;
            payloadValue[6] = tmpTime & 0xff;
            payloadValue[7] = (tmpTime >> 8) & 0xff;
            payloadValue[8] = 0x00;
            payloadValue[9] = 0x00;

            payloadValue[10] = 0x00;
            for (let i = 0; i < payloadValue[2] + 3; i++) {
                payloadValue[10] ^= payloadValue[i];
            }

            this.log('Sending inching command:', { enabled, mode, time_ms: time, time_half_seconds: tmpTime });

            const cluster = this.zclNode.endpoints[1].clusters['SonoffCluster'];
            const payloadBuffer = Buffer.from(payloadValue);
            await cluster.protocolData(
                { data: payloadBuffer },
                { disableDefaultResponse: true, waitForResponse: false }
            );
            this.log('Inching command sent successfully');
        } catch (error) {
            this.error('Failed to set inching:', error);
            throw error;
        }
    }

    async checkAttributes() {
        this.readAttribute(CLUSTER.ON_OFF, ['powerOnBehavior'], (data) => {
            this.setSettings({ power_on_behavior: data.powerOnBehavior }).catch(this.error);
        });

        this.readAttribute(SonoffCluster, SonoffClusterAttributes, (data) => {
            const settingsData = {
                ...data,
                TurboMode: data.TurboMode === 20,
                network_led: Boolean(data.network_led),
                power_on_delay_state: Boolean(data.power_on_delay_state),
                power_on_delay_time: data.power_on_delay_time / 2,
                switch_mode: String(data.switch_mode),
                detach_mode: Boolean(data.detach_mode)
            };
            this.setSettings(settingsData).catch(this.error);
        });
    }

    async onBecameAvailable() {
        this.log('Device became available');
        if (super.onBecameAvailable) await super.onBecameAvailable();
        // AvailabilityManager._markAllAvailable already fires the flow trigger.
        // Re-read attrs only if settings appear unpopulated (e.g. after factory reset).
        if (!this.getSetting('switch_mode')) {
            this.checkAttributes();
        }
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
