'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

/**
 * SonoffBase — shared base class for Sonoff Zigbee device drivers.
 * Provides battery-report wiring, retrying attribute reads, filtered
 * attribute writes, and idempotent teardown on uninit/delete.
 */
class SonoffBase extends ZigBeeDevice {

  /**
   * @param {object} args
   * @param {import('zigbee-clusters').ZCLNode} args.zclNode
   * @param {object} [options]
   * @param {boolean} [options.noAttribCheck] - Skip the powerConfiguration/battery
   *   listener wiring below (set by mains-powered drivers that have no battery cluster).
   */
  async onNodeInit({ zclNode }, options) {
    this.log(`NodeInit SonoffBase: ${this.getName()}`);
    options = options || {};
    this.printNode();

    if (options.noAttribCheck !== true) {
      if ('powerConfiguration' in zclNode.endpoints[1].clusters) {
        // Battery-powered devices report proactively — listen and update capability.
        // Keep a stable reference so the listener can be removed on teardown;
        // remove-then-add guards against duplicate accumulation if onNodeInit
        // runs again on a reused cluster object (node reuse is known to happen
        // on re-init — see the availability handleFrame hook).
        this._onBatteryReport ??= (value) => {
          this.log(`[Battery] ${value / 2}%`);
          this.setCapabilityValue('measure_battery', value / 2).catch(this.error);
        };
        const pc = this.zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME];
        pc.removeListener('attr.batteryPercentageRemaining', this._onBatteryReport);
        pc.on('attr.batteryPercentageRemaining', this._onBatteryReport);
      }
    }
  }

  /**
   * Read an attribute once, only on the device's first-ever init (not on every restart).
   * @param {object} cluster - A Cluster class or its NAME string.
   * @param {string|string[]} attr - Attribute name(s) to read.
   * @param {(data: object) => void} handler - Called with the read result.
   */
  async initAttribute(cluster, attr, handler) {
    if (!this.isFirstInit()) return;
    this.readAttribute(cluster, attr, handler);
  }

  /**
   * Read one or more attributes with exponential backoff + jitter retry.
   * @param {object} cluster - A Cluster class or its NAME string.
   * @param {string|string[]} attr - Attribute name(s) to read.
   * @param {(data: object) => void} handler - Called with the read result on success.
   * @param {number} [maxRetries] - Max retry attempts after the first try.
   * @param {number} [baseDelay] - Base delay in ms before exponential backoff + jitter.
   */
  async readAttribute(cluster, attr, handler, maxRetries = 3, baseDelay = 3000) {
    if ('NAME' in cluster) cluster = cluster.NAME;
    if (!Array.isArray(attr)) attr = [attr];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.log('Ask attribute', attr);
        const value = await this.zclNode.endpoints[1].clusters[cluster].readAttributes(...attr);
        this.log('Got attr', attr, value);
        handler(value);
        return;
      } catch (e) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt) * (0.5 + Math.random()); // jitter ±50%
          this.log(`Retry read attr ${attr} in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => this.homey.setTimeout(r, delay));
        } else {
          this.log('Device unreachable — attr read skipped:', attr);
        }
      }
    }
  }

  /**
   * Write a single attribute.
   * @param {object} cluster - A Cluster class or its NAME string.
   * @param {string} attr - Attribute name.
   * @param {*} value - Value to write.
   */
  async writeAttribute(cluster, attr, value) {
    const data = {};
    data[attr] = value;
    this.writeAttributes(cluster, data);
  }

  /**
   * Write multiple attributes, silently dropping any key the cluster doesn't
   * declare (and any key not in `filter`, when given).
   * @param {object} cluster - A Cluster class or its NAME string.
   * @param {object} attribs - Map of attribute name → value.
   * @param {string[]} [filter] - If given, only these keys are written.
   * @returns {Promise<*>} The result of the underlying writeAttributes call.
   */
  async writeAttributes(cluster, attribs, filter = null) {
    let items = {};
    try {
      if ('NAME' in cluster) cluster = cluster.NAME;
      const clust = this.zclNode.endpoints[1].clusters[cluster];
      items = {};
      for (const key in attribs) {
        if (filter && !filter.includes(key)) continue;
        if (!(key in clust.constructor.attributes)) continue;
        items[key] = attribs[key];
      }

      if (!Object.keys(items).length) {
        this.log('Write attribute', {});
        return undefined;
      }

      this.log('Write attribute', items);
      return await clust.writeAttributes(items);
    } catch (error) {
      this.error('Error write attr', items, error);
      throw error;
    }
  }

  /**
   * Convert a wire value read as unsigned 32-bit into its signed interpretation.
   * Several Sonoff manufacturer-specific attributes (e.g. acCurrentPowerValue)
   * are transmitted two's-complement but declared/read as uint32.
   * @param {number} raw - Unsigned 32-bit value as read from the wire.
   * @returns {number} Signed 32-bit value.
   */
  _toSignedInt32(raw) {
    return raw > 0x7fffffff ? raw - 0x100000000 : raw;
  }

  /**
   * Install a node-level `handleFrame` interceptor for a manufacturer-specific
   * cluster whose reportAttributes frames the zigbee-clusters auto-parser
   * can't decode (type mismatches), and/or whose clusterSpecific commands
   * have no BoundCluster handler (causing "binding_unavailable" log spam).
   *
   * Two responsibilities:
   *  1. reportAttributes (cmdId 0x0A) — parses the buffer manually against
   *     `cluster.ATTRIBUTES` and emits `attr.<name>` events on the cluster
   *     instance instead of relying on the framework's auto-parser.
   *  2. Any cmdId listed in `opts.suppressCmdIds` — swallowed silently, but
   *     still counts as activity for the availability watchdog (useful for
   *     a periodic status/heartbeat command that has no attribute payload).
   *
   * Guarded against re-installing on re-init: `this.node` can be reused by
   * the framework across an `onNodeInit` re-run, and wrapping `handleFrame`
   * again on the same node would stack interceptors indefinitely.
   *
   * @param {object} cluster - A Cluster class exposing ID, NAME and ATTRIBUTES
   *   (e.g. SonoffCluster).
   * @param {object} [opts]
   * @param {number[]} [opts.suppressCmdIds] - cmdIds to swallow (besides 0x0A).
   */
  _installClusterReportInterceptor(cluster, { suppressCmdIds = [] } = {}) {
    const endpoint = this.zclNode.endpoints[1];
    const clusterInstance = endpoint.clusters[cluster.NAME];
    if (!clusterInstance) return;

    const installedFlag = `_${cluster.NAME}ReportInterceptorInstalled`;
    if (this.node[installedFlag]) {
      this.log(`[${cluster.NAME}] report interceptor already installed (shared node)`);
      return;
    }

    const ATTR_MAP = {};
    for (const [name, def] of Object.entries(cluster.ATTRIBUTES)) {
      if (!ATTR_MAP[def.id]) ATTR_MAP[def.id] = { name, type: def.type };
    }

    // Fallback sizes, used only for an attrId the device sends that isn't in
    // cluster.ATTRIBUTES. Known attributes are sized from their own
    // `type.length` instead of guessed from the wire type byte.
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
      if (clusterId === cluster.ID && Buffer.isBuffer(frame) && frame.length >= 2) {
        const cmdId = frame[0];

        if (cmdId === 0x0A) { // reportAttributes
          this._availability?.notifyActivity(cluster.NAME);
          const data = frame.slice(1);
          let offset = 0;
          while (offset + 3 <= data.length) {
            const attrId = data.readUInt16LE(offset);
            offset += 2;
            const typeId = data[offset++];
            const attr = ATTR_MAP[attrId];
            const size = (attr?.type?.length > 0) ? attr.type.length : (TYPE_SIZES[typeId] || 2);
            if (offset + size > data.length) break;
            if (attr) {
              const value = readValue(data, offset, typeId);
              clusterInstance.emit(`attr.${attr.name}`, value);
            }
            offset += size;
          }
          return Promise.resolve(); // skip framework auto-parser
        }

        if (suppressCmdIds.includes(cmdId)) {
          this._availability?.notifyActivity(`${cluster.NAME}-status`);
          return Promise.resolve();
        }
      }
      return hook(...args);
    };

    this.node[installedFlag] = true;
  }

  // onUninit fires on re-init/restart (onDeleted only on user removal).
  // Subclasses set this._availability; clean it up on both paths.
  async onUninit() {
    await this._teardown();
  }

  onDeleted() {
    this._teardown();
    this.log('sonoff device removed');
  }

  /** Idempotent cleanup — safe to call from both onUninit and onDeleted. */
  async _teardown() {
    this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.POWER_CONFIGURATION.NAME]
      ?.removeListener('attr.batteryPercentageRemaining', this._onBatteryReport);
    await this._availability?.uninstall().catch(() => {});
  }

}

module.exports = SonoffBase;
