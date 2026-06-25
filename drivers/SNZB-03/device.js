'use strict';

const SonoffBase = require('../../lib/SonoffBase');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
const { BasicSilentBoundCluster } = require('../../lib/TimeCluster');
const IASZoneHelper = require('../../lib/IASZoneHelper');
const { BATTERY_DEVICE_HEARTBEAT_MS } = require('../../lib/constants');

class SonoffSNZB03 extends SonoffBase {

    async onNodeInit({ zclNode }) {

        await super.onNodeInit({ zclNode }, { noAttribCheck: true });

        // Availability tracking - Cluster0 captures ALL frames (including cluster 0 basic)
        this._availability = new AvailabilityManagerCluster0(this, { timeout: BATTERY_DEVICE_HEARTBEAT_MS });
        await this._availability.install();

        // Silence cluster 0 frames to avoid "cluster_unavailable" errors
        try { 
            if (zclNode.endpoints[1]?.clusters?.basic) {
                zclNode.endpoints[1].bind('basic', new BasicSilentBoundCluster()); 
            }
        } catch {}

        // Fix upgrade from older versions that used alarm_contact
        if (this.hasCapability('alarm_contact') === true) {
            await this.removeCapability('alarm_contact');
            await this.addCapability('alarm_motion');
        }

        // The SNZB-03 is a sleepy end-device. It sends battery reports
        // autonomously; configureReporting often races the sleep window and
        // the Homey Zigbee stack logs an error before our catch can handle it.
        // Listen for battery reports
        const powerConfig = zclNode.endpoints[1].clusters.powerConfiguration;
        if (powerConfig) {
            this._absorbLateGlobalResponses(powerConfig);
            powerConfig.on('attr.batteryPercentageRemaining', value => {
                const pct = Math.round(value / 2);
                this.log(`[Battery] ${pct}% (raw=${value})`);
                this.setCapabilityValue('measure_battery', pct).catch(this.error);
                this._availability?.notifyActivity('battery-report');
            });
        }

        this._iasZone = new IASZoneHelper(this, {
            endpointId: 1,
            zoneId: 1,
            sendEnrollOnInit: false,  // Defer to when device wakes up
            readInitialState: false,  // Defer to when device wakes up
            onActivity: source => this._handleWakeActivity(source),
            onStatus: zoneStatus => this.zoneStatusChangeNotification(zoneStatus),
        });
        await this._iasZone.init(zclNode);
        this._absorbLateGlobalResponses(zclNode.endpoints[1].clusters.iasZone);

        // Mark enrollment as pending for retry on wake
        this._enrollPending = true;
        this._enrollRetrying = false;

        this.log('SNZB-03 initialized (end-device, operations deferred to wake)');
    }

    async _retryEnrollAndRead() {
        // Try to send enroll response when device wakes up
        if (!this._enrollPending || this._enrollRetrying || !this._iasZone) return;

        this._enrollRetrying = true;
        try {
            const success = await this._iasZone.sendEnrollResponse('wake');
            if (success) this._enrollPending = false;
        } finally {
            this._enrollRetrying = false;
        }
    }

    _handleWakeActivity(source) {
        this._availability?.notifyActivity(source);
        this._retryEnrollAndRead().catch(err => {
            this.log('[IAS] Wake enrollment retry failed:', err.message);
        });
    }

    zoneStatusChangeNotification(zoneStatus) {
        const motion = IASZoneHelper.hasAlarm(zoneStatus);
        this.setCapabilityValue('alarm_motion', motion).catch(this.error);
    }

    _absorbLateGlobalResponses(cluster) {
        if (!cluster || cluster._homeSuiteLateResponseHandlers) return;
        cluster._homeSuiteLateResponseHandlers = true;

        const noop = () => {};
        cluster['onReadAttributes.response'] = noop;
        cluster['onReadAttributesStructured.response'] = noop;
        cluster['onWriteAttributes.response'] = noop;
        cluster['onWriteAttributesAtomic.response'] = noop;
        cluster['onConfigureReporting.response'] = noop;
        cluster.onDefaultResponse = noop;
    }

    onEndDeviceAnnounce() {
        this.log('Device rejoined network (End Device Announce)');
        this._availability?.notifyActivity('end-device-announce');
        // Retry enrollment when device wakes up. Battery is handled by
        // autonomous reports/read attempts, not configureReporting.
        this._retryEnrollAndRead();
        const powerConfig = this.zclNode?.endpoints?.[1]?.clusters?.powerConfiguration;
        if (powerConfig) {
            powerConfig.readAttributes(['batteryPercentageRemaining'])
                .then(attrs => {
                    if (attrs.batteryPercentageRemaining !== undefined) {
                        const pct = Math.round(attrs.batteryPercentageRemaining / 2);
                        this.log(`[Battery] Rejoin: ${pct}% (raw=${attrs.batteryPercentageRemaining})`);
                        this.setCapabilityValue('measure_battery', pct).catch(this.error);
                    }
                })
                .catch(err => this.log('[Battery] Could not read on rejoin (will retry):', err.message));
        }
    }

    async _teardown() {
        this._iasZone?.dispose();
        await super._teardown();
    }

    async onDeleted() {
        await this._teardown();
        this.log('SNZB-03 removed');
    }

}

module.exports = SonoffSNZB03;
