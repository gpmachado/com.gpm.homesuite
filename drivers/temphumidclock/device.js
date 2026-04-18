'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const AvailabilityManager = require('../../lib/AvailabilityManager');
const { AvailabilityManagerCluster0 } = AvailabilityManager;
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

    // Availability watchdog — install FIRST so the boot time sync (sendTimeResponse)
    // and initial queryDatapoints generate frames that mark the device as available.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: TEMPHUMID_CLOCK_HEARTBEAT_MS,
    });
    await this._availability.install();

    // Silence ZCL time cluster frames (clock syncs via Tuya ef00, not ZCL time cluster)
    try { zclNode.endpoints[1].bind('time', new TimeSilentBoundCluster()); } catch {}

    const tuyaCluster = zclNode.endpoints[1].clusters.tuya;

    this.lastQueryAt = 0;
    this.lastTimeSyncAt = 0;
    this._lastReported = {};  // Deduplicate repeated datapoint reports

    // Device woke up and reported data - opportunistic query
    tuyaCluster.on('reporting', async value => {
      this.processDatapoint(value);

      // Throttle queries to once per 60s (battery saving)
      const now = Date.now();
      if (now - this.lastQueryAt > 60000) {
        this.lastQueryAt = now;
        await this.sleep(200);
        await this.queryDatapoints();
      }
    });

    // Response to query/write commands
    tuyaCluster.on('response', value => {
      this.processDatapoint(value);
    });

    // Heartbeat = device is awake - good time for opportunistic query + time sync
    tuyaCluster.on('heartbeat', async heartbeat => {
      const status = heartbeat.status || 0;
      const value = heartbeat.value || 0;
      const marker = heartbeat.marker || 0;
      this.log(`Heartbeat [${status},${value},0x${marker.toString(16)}]`);

      const now = Date.now();

      // Throttle queries to once per 60s
      if (now - this.lastQueryAt > 60000) {
        this.lastQueryAt = now;
        await this.sleep(200);
        await this.queryDatapoints();
      }

      // Proactive time sync every 10 minutes (device doesn't request)
      if (!this.lastTimeSyncAt || now - this.lastTimeSyncAt > 600000) {
        this.lastTimeSyncAt = now;
        await this.sleep(300);
        try {
          await this.sendTimeResponse();
          this.log('Proactive time sync sent');
        } catch (err) {
          this.error('Proactive sync failed:', err.message);
        }
      }
    });

    // Device requests time sync - respond immediately
    tuyaCluster.on('timeRequest', async (request) => {
      this.log('Time request received');
      try {
        await this.sendTimeResponse(request);
      } catch (err) {
        this.error('Time sync failed:', err.message);
      }
    });

    this.log('Listeners ready');

    // Initial query + time sync after startup
    this.homey.setTimeout(async () => {
      this.log(`Init complete [v${VERSION}]`);
      await this.queryDatapoints();

      // Initial time sync
      await this.sleep(500);
      try {
        await this.sendTimeResponse();
        this.log('Initial time sync sent');
      } catch (err) {
        this.error('Initial sync failed:', err.message);
      }

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

  // Query all datapoints from device (cmd 0x03)
  async queryDatapoints() {
    try {
      await this.zclNode.endpoints[1].clusters.tuya.dataQuery({
        transid: this.transactionID
      });
      this.log('DP query sent');
    } catch (error) {
      this.log(`Query error: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => this.homey.setTimeout(resolve, ms));
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

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`Removed [v${VERSION}]`);
    if (super.onDeleted) super.onDeleted();
  }
}

module.exports = TempHumidClock;
