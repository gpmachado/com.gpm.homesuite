'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
const { isDeviceUnreachable } = require('../../lib/errorUtils');
const { TimeSilentBoundCluster } = require('../../lib/TimeCluster');
const { APP_VERSION, TEMPHUMID_CLOCK_HEARTBEAT_MS } = require('../../lib/constants');

const VERSION = APP_VERSION;

// Tuya datapoints for temperature/humidity/battery sensor
const dataPoints = {
  temperature: 1,  // Temperature in 0.1°C (value/10)
  humidity: 2,     // Humidity in %
  battery: 3,      // Battery enum: 0=33%, 1=66%, 2=100%
  tempUnit: 9      // Temperature unit: 0=Celsius, 1=Fahrenheit
};

class TempHumidClock extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this.printNode();

    this.log(`Tuya Temp/Hum Clock [v${VERSION}]`);
    this.log('Battery optimized - Auto timezone');

    // Migrate existing paired devices: add is_availability if missing
    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    // Availability watchdog — install FIRST so inbound wake/rejoin frames mark
    // the sleepy device as available without needing active polling.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: TEMPHUMID_CLOCK_HEARTBEAT_MS,
    });
    await this._availability.install();

    try {
      zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster({
        onReadAttributes: () => this._handleZclTimeRead(),
      }));
    } catch {}

    const tuyaCluster = zclNode.endpoints[1].clusters.tuya;

    this._lastReported = {};  // Deduplicate repeated datapoint reports

    // Device woke up and reported data.
    tuyaCluster.on('reporting', async value => {
      this._markAliveFromAvailability?.('tuya-reporting');
      this.processDatapoint(value);
    });

    // Response to query/write commands
    tuyaCluster.on('response', value => {
      this._markAliveFromAvailability?.('tuya-response');
      this.processDatapoint(value);
    });

    // Heartbeat = device is awake. Keep this passive: the device asks for time
    // when it needs it, and extra commands during rejoin can miss the wake window.
    tuyaCluster.on('heartbeat', async heartbeat => {
      const status = heartbeat.status || 0;
      const value = heartbeat.value || 0;
      const marker = heartbeat.marker || 0;
      this.log(`Heartbeat [${status},${value},0x${marker.toString(16)}]`);
      this._markAliveFromAvailability?.('tuya-heartbeat');
    });

    // Device requests time sync - respond immediately
    tuyaCluster.on('timeRequest', async (request) => {
      this.log('Time request received');
      this._markAliveFromAvailability?.('tuya-time-request');
      this._lastTuyaTimeRequestAt = Date.now();
      try {
        await this.sendTimeResponse(request, { timeout: 3000 });
      } catch (err) {
        if (isDeviceUnreachable(err)) this.log('Time sync skipped — device sleeping');
        else this.error('Time sync failed:', err.message);
      }

      try {
        await this._sendClockHandshake('time-request');
      } catch (err) {
        if (isDeviceUnreachable(err)) this.log('Clock handshake skipped — device sleeping');
        else this.error('Clock handshake failed:', err.message);
      }
    });

    this.log('Listeners ready');

    // Avoid active init traffic for this sleepy clock. It reports datapoints and
    // requests time on its own during pairing/rejoin.
    this.homey.setTimeout(async () => {
      this.log(`Init complete [v${VERSION}]`);
      const tz = this.homey.clock.getTimezone();
      this.log(`Ready - TZ: ${tz}`);
    }, 2000);
  }

  processDatapoint(data) {
    const dp = data.dp;
    const value = this._parseDataValue(data);

    if (value === null || value === undefined) {
      this.log(`Unknown datatype for DP${dp}`);
      return;
    }

    // Skip if value hasn't changed — device sends bursts of repeated frames on wake
    if (this._lastReported[dp] === value) return;
    this._lastReported[dp] = value;

    switch (dp) {
      case dataPoints.temperature: {
        const temp = value / 10;
        this.log(`Temp: ${temp.toFixed(1)}C`);
        this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        break;
      }

      case dataPoints.humidity: {
        const hum = value;
        this.log(`Humidity: ${hum}%`);
        this.setCapabilityValue('measure_humidity', hum).catch(this.error);
        break;
      }

      case dataPoints.battery: {
        const batteryPercent = [33, 66, 100][value];
        if (batteryPercent !== undefined) {
          this.log(`Battery: ${batteryPercent}%`);
          this.setCapabilityValue('measure_battery', batteryPercent).catch(this.error);
        } else {
          this.log(`Battery: unknown value ${value}`);
        }
        break;
      }

      case dataPoints.tempUnit: {
        const unit = value === 0 ? 'C' : 'F';
        this.log(`Unit: ${unit}`);
        break;
      }

      default:
        this.log(`Unknown DP${dp}=${value}`);
    }
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

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._lastEndDeviceAnnounceAt = Date.now();
    this._markAliveFromAvailability?.('end-device-announce');
  }

  _handleZclTimeRead() {
    this._markAliveFromAvailability?.('zcl-time-read');

    const now = Date.now();
    const lastFallbackAt = this._lastZclTimeFallbackAt || 0;
    const isNewRejoin = (this._lastEndDeviceAnnounceAt || 0) > lastFallbackAt;
    if (!isNewRejoin && now - lastFallbackAt < 120000) return;
    if (now - (this._lastTuyaTimeRequestAt || 0) < 10000) return;
    this._lastZclTimeFallbackAt = now;

    this.homey.setTimeout(async () => {
      if (Date.now() - (this._lastTuyaTimeRequestAt || 0) < 10000) return;
      try {
        await this.sendTimeResponse(null, { waitForResponse: false });
        await this._sendClockHandshake('zcl-time-fallback');
        this.log('ZCL time fallback sync sent');
      } catch (err) {
        if (isDeviceUnreachable(err)) this.log('ZCL time fallback skipped — device sleeping');
        else this.error('ZCL time fallback failed:', err.message);
      }
    }, 250);
  }

  async _sendClockHandshake(reason) {
    const now = Date.now();
    const lastHandshakeAt = this._lastClockHandshakeAt || 0;
    const isNewRejoin = (this._lastEndDeviceAnnounceAt || 0) > lastHandshakeAt;
    if (!isNewRejoin && now - lastHandshakeAt < 120000) return;
    this._lastClockHandshakeAt = now;

    const tuyaCluster = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (!tuyaCluster?.dataQuery || !tuyaCluster?.gatewayStatus) return;

    await tuyaCluster.dataQuery({});
    await new Promise(resolve => this.homey.setTimeout(resolve, 300));
    await tuyaCluster.gatewayStatus({ payload: Buffer.from([0x00, 0x36]) });
    this.log(`Clock handshake sent (${reason})`);
  }

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`Removed [v${VERSION}]`);
    if (super.onDeleted) super.onDeleted();
  }
}

module.exports = TempHumidClock;
