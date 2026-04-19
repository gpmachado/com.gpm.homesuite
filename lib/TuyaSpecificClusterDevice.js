/**
 * TuyaSpecificClusterDevice.js
 *
 * @version 4.3.1 - Added jitter to exponential backoff (thundering herd prevention)
 * @date 2026-03-21
 *
 * CHANGES vs v4.2.0:
 *
 *   ✅ Exponential backoff retry added to all write methods
 *      - writeBool(dp, value, maxRetries=2, baseDelay=300)
 *      - writeData32(dp, value, maxRetries=2, baseDelay=300)
 *      - writeEnum(dp, value, maxRetries=2, baseDelay=300)
 *      - writeString(dp, value, maxRetries=2, baseDelay=300)
 *      - writeRaw(dp, data, maxRetries=2, baseDelay=300)
 *
 *   ✅ _sendTuyaDatapoint now handles retry logic internally
 *      - Exponential backoff: delay * 2^attempt
 *      - Example: 300ms → 600ms → 1200ms → 2400ms → 4800ms
 *      - Configurable per-call (commands vs settings)
 *
 *   ✅ Maintains backward compatibility
 *      - Default maxRetries=2 (balanced)
 *      - Existing calls work without changes
 *      - Devices can override per-call
 */

'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const AvailabilityManager = require('./AvailabilityManager');
const { TimeSilentBoundCluster, BasicSilentBoundCluster } = require('./TimeCluster');
const { getNodeDevices, writeSiblingNames, updateSiblingNames } = require('./connectedDevices');

class TuyaSpecificClusterDevice extends ZigBeeDevice {

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════════════════

  /** Override in subclass for non-standard endpoint */
  tuyaEndpoint = 1;

  // ═══════════════════════════════════════════════════════════════════════
  // TRANSACTION ID
  // ═══════════════════════════════════════════════════════════════════════

  _transactionID = 0;

  /** Auto-incrementing, wraps at 256 */
  get transactionID() {
    return this._transactionID++ % 256;
  }

  /** Reset counter to 0. Useful for debug/recovery. */
  resetTransactionId() {
    this._transactionID = 0;
    this.log('[TuyaDevice] transactionID reset');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEVICE READINESS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * True when zclNode + endpoint + tuya cluster are all accessible.
   * @returns {boolean}
   */
  isDeviceReady() {
    return !!(this.zclNode?.endpoints?.[this.tuyaEndpoint]?.clusters?.tuya);
  }

  /**
   * Wait for device ready using exponential backoff.
   * 250 → 500 → 1000ms (capped), up to maxMs total.
   *
   * @param {number} [maxMs=10000]
   * @throws {Error} if not ready within maxMs
   */
  async waitForDeviceReady(maxMs = 10000) {
    const start = Date.now();
    let delayMs = 250;

    while (!this.isDeviceReady()) {
      if (Date.now() - start > maxMs) {
        throw new Error(`[TuyaDevice] Not ready after ${maxMs}ms`);
      }
      await new Promise(r => this.homey.setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 1000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Waits for Tuya cluster before handing off to subclass.
   * Subclasses must call: await super.onNodeInit(props)
   */
  async onNodeInit(props) {
    await super.onNodeInit(props);
    try {
      await this.waitForDeviceReady();
      this.log('[TuyaDevice] cluster ready');

      // Suppress "binding_unavailable" log spam from Tuya devices that have
      // an OUTPUT binding to the coordinator's Time cluster (0x000A).
      // endpoint.bind() registers a BoundCluster so the endpoint routes frames
      // there instead of emitting binding_unavailable.
      try {
        const ep1 = this.zclNode?.endpoints?.[1];
        if (ep1?.clusters?.time)  ep1.bind('time',  new TimeSilentBoundCluster());
        if (ep1?.clusters?.basic) ep1.bind('basic', new BasicSilentBoundCluster());
      } catch (err) { }

    } catch (err) {
      this.error('[TuyaDevice] waitForDeviceReady failed:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WRITE METHODS (with exponential backoff retry)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Write boolean datapoint with retry
   * @param {number} dp - Datapoint
   * @param {boolean} value - Boolean value
   * @param {number} [maxRetries=2] - Max retry attempts
   * @param {number} [baseDelay=300] - Base delay in ms (exponential backoff)
   */
  async writeBool(dp, value, maxRetries = 2, baseDelay = 300) {
    if (typeof value !== 'boolean') {
      throw new Error(`writeBool: expected boolean, got ${typeof value}`);
    }
    return this._sendTuyaDatapoint(dp, 1, Buffer.from([value ? 1 : 0]), maxRetries, baseDelay);
  }

  /**
   * Write 32-bit value datapoint with retry
   * @param {number} dp - Datapoint
   * @param {number} value - Uint32 value
   * @param {number} [maxRetries=2] - Max retry attempts
   * @param {number} [baseDelay=300] - Base delay in ms
   */
  async writeData32(dp, value, maxRetries = 2, baseDelay = 300) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
      throw new Error(`writeData32: invalid uint32: ${value}`);
    }
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value, 0);
    return this._sendTuyaDatapoint(dp, 2, buf, maxRetries, baseDelay);
  }

  /**
   * Write string datapoint with retry
   * @param {number} dp - Datapoint
   * @param {string} value - String value
   * @param {number} [maxRetries=2] - Max retry attempts
   * @param {number} [baseDelay=300] - Base delay in ms
   */
  async writeString(dp, value, maxRetries = 2, baseDelay = 300) {
    return this._sendTuyaDatapoint(dp, 3, Buffer.from(String(value), 'latin1'), maxRetries, baseDelay);
  }

  /**
   * Write enum datapoint with retry
   * @param {number} dp - Datapoint
   * @param {number} value - Enum value (0-255)
   * @param {number} [maxRetries=2] - Max retry attempts
   * @param {number} [baseDelay=300] - Base delay in ms
   */
  async writeEnum(dp, value, maxRetries = 2, baseDelay = 300) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`writeEnum: invalid enum: ${value}`);
    }
    return this._sendTuyaDatapoint(dp, 4, Buffer.from([value]), maxRetries, baseDelay);
  }

  /**
   * Write raw buffer datapoint with retry
   * @param {number} dp - Datapoint
   * @param {Buffer} data - Raw buffer
   * @param {number} [maxRetries=2] - Max retry attempts
   * @param {number} [baseDelay=300] - Base delay in ms
   */
  async writeRaw(dp, data, maxRetries = 2, baseDelay = 300) {
    if (!Buffer.isBuffer(data)) {
      throw new Error('writeRaw: data must be a Buffer');
    }
    return this._sendTuyaDatapoint(dp, 0, data, maxRetries, baseDelay);
  }

  /**
   * Alias for writeData32 (legacy compatibility)
   */
  async writeValue(dp, value, maxRetries = 2, baseDelay = 300) {
    return this.writeData32(dp, value, maxRetries, baseDelay);
  }

  /**
   * Send Tuya datapoint with exponential backoff retry
   * @private
   * @param {number} dp - Datapoint
   * @param {number} datatype - Data type (0=raw, 1=bool, 2=value, 3=string, 4=enum)
   * @param {Buffer} data - Data buffer
   * @param {number} [maxRetries=2] - Max retry attempts
   * @param {number} [baseDelay=300] - Base delay in ms
   */
  async _sendTuyaDatapoint(dp, datatype, data, maxRetries = 2, baseDelay = 300) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Check device ready
        const ep = this.zclNode?.endpoints?.[this.tuyaEndpoint];
        if (!ep?.clusters?.tuya) {
          throw new Error(`[TuyaDevice] tuya cluster not on ep${this.tuyaEndpoint}`);
        }

        // Send datapoint
        await ep.clusters.tuya.datapoint({
          status: 0,
          transid: this.transactionID,
          dp,
          datatype,
          length: data.length,
          data
        });

        // Success
        if (attempt > 0) {
          this.log(`[TuyaDevice] DP${dp} succeeded on attempt ${attempt + 1}`);
        }
        return;

      } catch (err) {
        lastError = err;

        // Don't retry if last attempt
        if (attempt < maxRetries) {
          // Exponential backoff with proportional jitter to avoid thundering herd:
          // base: 300ms → 600ms → 1200ms, plus random 0..baseDelay to desync retries
          const delay = (baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * baseDelay);
          this.log(`[TuyaDevice] DP${dp} retry ${attempt + 1}/${maxRetries}, waiting ${delay}ms...`);
          await new Promise(resolve => this.homey.setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed
    this.error(`[TuyaDevice] DP${dp} failed after ${maxRetries + 1} attempts:`, lastError.message);
    throw lastError;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BULK COMMANDS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Send multiple commands in sequence with rate-limiting.
   *
   * @param {Array<{type: string, dp: number, value: *}>} commands
   * @param {number} [delayBetween=200] ms between commands (min 150 enforced)
   * @returns {Promise<Array<{success, dp, result?, error?}>>}
   */
  async sendBulkCommands(commands, delayBetween = 200) {
    if (!Array.isArray(commands) || commands.length === 0) return [];

    if (!this.getAvailable()) {
      this.log('[TuyaDevice] sendBulkCommands: unavailable — aborted');
      return commands.map(c => ({ success: false, dp: c?.dp, error: 'device unavailable' }));
    }

    const delay = Math.max(150, delayBetween);
    const results = [];
    let fails = 0;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];

      if (fails >= 2) {
        results.push({ success: false, dp: cmd?.dp, error: 'aborted: consecutive failures' });
        continue;
      }

      try {
        let result;
        // Bulk commands use fewer retries (2 max, 200ms base)
        switch (cmd.type) {
          case 'bool': result = await this.writeBool(cmd.dp, cmd.value, 2, 200); break;
          case 'enum': result = await this.writeEnum(cmd.dp, cmd.value, 2, 200); break;
          case 'data32': result = await this.writeData32(cmd.dp, cmd.value, 2, 200); break;
          case 'string': result = await this.writeString(cmd.dp, cmd.value, 2, 200); break;
          case 'raw': result = await this.writeRaw(cmd.dp, cmd.value, 2, 200); break;
          default: throw new Error(`unknown type: ${cmd.type}`);
        }
        results.push({ success: true, dp: cmd.dp, result });
        fails = 0;
      } catch (err) {
        this.error(`[TuyaDevice] bulk DP${cmd.dp}:`, err.message);
        results.push({ success: false, dp: cmd.dp, error: err.message });
        fails++;
      }

      if (i < commands.length - 1) {
        await new Promise(r => this.homey.setTimeout(r, delay));
      }
    }

    const ok = results.filter(r => r.success).length;
    this.log(`[TuyaDevice] sendBulkCommands: ${ok}/${commands.length} ok`);
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DATAPOINT PARSING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Parse a Tuya datapoint value object into a JavaScript type.
   *
   * @param {Object} dpValue
   * @param {number} dpValue.datatype - 0=raw, 1=bool, 2=value, 3=string, 4=enum, 5=bitmap
   * @param {Buffer|Array<number>} dpValue.data
   * @returns {boolean|number|string|Buffer}
   */
  _parseDataValue(dpValue) {
    switch (dpValue.datatype) {
      case 0: return dpValue.data;
      case 1: return dpValue.data[0] === 1;
      case 2: return this._bufToUint32(dpValue.data);
      case 3: return String.fromCharCode(...dpValue.data);
      case 4: return dpValue.data[0];
      case 5: return this._bufToUint32(dpValue.data);
      default: throw new Error(`Unsupported datatype: ${dpValue.datatype}`);
    }
  }

  /**
   * Convert a big-endian byte array to an unsigned 32-bit integer.
   *
   * @param {Buffer|Array<number>} buf
   * @returns {number}
   */
  _bufToUint32(buf) {
    return buf.reduce((acc, b) => (acc << 8) | b, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEBUG
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Device state snapshot for debugging.
   */
  getTransactionStats() {
    return {
      currentTransactionId: this._transactionID,
      deviceReady: this.isDeviceReady(),
      deviceName: this.getName?.() || 'unknown',
      tuyaEndpoint: this.tuyaEndpoint,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TIME SYNC
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Send time sync response to device.
   */
  async sendTimeResponse(request = null) {
    const t0 = Date.now();
    const now = new Date();
    const utcSeconds = Math.floor(now.getTime() / 1000);

    let offsetSeconds = 0;
    try {
      const tz = await this.homey.clock.getTimezone();
      const loc = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      offsetSeconds = Math.floor((loc - now) / 1000);
    } catch {
      offsetSeconds = now.getTimezoneOffset() * -60;
    }

    const localSeconds = utcSeconds + offsetSeconds;
    let use10Bytes = true;
    let prefix = 'no-request';

    const reqData = request?.payload || request?.data;
    if (reqData && Buffer.isBuffer(reqData) && reqData.length >= 2) {
      const b0 = reqData[0], b1 = reqData[1];
      prefix = `0x${b0.toString(16).padStart(2, '0')} 0x${b1.toString(16).padStart(2, '0')}`;
      if ((b0 === 0x00 && b1 === 0x06) || (b0 === 0x00 && b1 === 0x00)) use10Bytes = false;
    }

    const payload = Buffer.alloc(use10Bytes ? 10 : 8);
    if (use10Bytes) {
      payload.writeUInt8(0x00, 0);
      payload.writeUInt8(0x08, 1);
      payload.writeUInt32BE(utcSeconds, 2);
      payload.writeUInt32BE(localSeconds, 6);
    } else {
      payload.writeUInt32BE(utcSeconds, 0);
      payload.writeUInt32BE(localSeconds, 4);
    }

    const ep = this.zclNode?.endpoints?.[this.tuyaEndpoint];
    if (!ep) throw new Error('[TuyaDevice] sendTimeResponse: endpoint not available');

    const cluster = ep.clusters.tuya || ep.clusters[0xEF00];
    if (!cluster) throw new Error('[TuyaDevice] sendTimeResponse: tuya cluster not available');

    await cluster.setTime({ payload });

    const offsetH = (offsetSeconds / 3600).toFixed(1);
    const timeStr = new Date(localSeconds * 1000).toISOString().substring(11, 16);
    this.log(`✓ Time synced: ${timeStr} | ${use10Bytes ? '10B' : '8B'} | Offset: ${offsetH}h | Prefix: ${prefix} | ${Date.now() - t0}ms`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONNECTED DEVICES (siblings)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Returns all Homey device instances sharing this physical Zigbee node.
   * Delegates to connectedDevices.getNodeDevices — drivers no longer need
   * their own copy of this logic.
   *
   * @returns {Array}
   */
  _getNodeDevices() {
    return getNodeDevices(this);
  }

  /**
   * Writes a personalised device_siblings_info label to every sibling.
   * Each receiver gets its own text with "(this)" pointing to itself.
   *
   * @param {Array} siblings - already filtered and sorted by the calling driver
   */
  async _writeSiblingNames(siblings) {
    await writeSiblingNames(siblings);
  }

  /**
   * Get siblings via ieeeAddress, optionally sort, and write labels.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.mainOnly=false]  skip if this is not the main sub-device
   * @param {Function}[opts.sortFn]          comparator for Array.sort()
   */
  async _updateSiblingNames(opts) {
    await updateSiblingNames(this, opts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AVAILABILITY FLOW ENGINE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fired by Homey when the device comes back on the network.
   *
   * Two paths:
   *  A) AvailabilityManager watchdog → calls _markAllAvailable() → fires trigger
   *     → then calls onBecameAvailable(). Guard prevents double-trigger.
   *  B) Homey native rejoin detection (no watchdog installed) → calls this directly.
   *     Guard is false → trigger fires here (only time it should).
   */
  async onBecameAvailable() {
    this.log('[TuyaDevice] Device became available');
    // If AvailabilityManager is installed it already fired the trigger in _markAllAvailable.
    if (!this._availability) {
      AvailabilityManager.trigger(this, true);
    }
  }

  /**
   * Fired by Homey when the device goes offline.
   * Same two-path rationale as onBecameAvailable above.
   */
  async onBecameUnavailable(reason) {
    this.log('[TuyaDevice] Device became unavailable');
    if (!this._availability) {
      AvailabilityManager.trigger(this, false);
    }
  }
}

module.exports = TuyaSpecificClusterDevice;
