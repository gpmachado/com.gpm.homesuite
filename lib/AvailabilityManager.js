'use strict';

/**
 * @file AvailabilityManager.js
 * @description Zigbee device availability tracking + flow-card trigger helper.
 *
 * ## Static helper (used everywhere)
 * ```js
 * const AvailabilityManager = require('../../lib/AvailabilityManager');
 * AvailabilityManager.trigger(this, true);   // fire availability_turned_on
 * ```
 *
 * ## AvailabilityManagerCluster0 — passive handleFrame hook
 * Hooks node.handleFrame to detect ANY inbound Zigbee frame (Basic keepalives,
 * Tuya EF00, poll responses, attribute reports …) with ZERO extra network traffic.
 * ```js
 * const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
 * // main device only:
 * this._availability = new AvailabilityManagerCluster0(this, { timeout: 25 * 60 * 1000 });
 * await this._availability.install();
 * // in onDeleted:
 * this._availability?.uninstall().catch(() => {});
 * ```
 *
 * ## AvailabilityManagerCluster6 — callback-driven (battery sensors)
 * Injects device._markAliveFromAvailability(source) for explicit signalling.
 * ```js
 * const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
 * this._availability = new AvailabilityManagerCluster6(this, { timeout: 3 * 60 * 60 * 1000 });
 * await this._availability.install();
 * // in every inbound data handler:
 * this._markAliveFromAvailability?.('reporting');
 * ```
 *
 * ## Multi-gang cascade
 * _getSiblings() resolves all Homey device instances sharing the same physical
 * Zigbee node (by ieeeAddress, then token fallback) so a single timeout marks
 * or restores all virtual gangs atomically.
 *
 * ## Persistence
 * last_seen_ts is stored via setStoreValue — survives app restarts.
 * After a restart, if the device was last seen longer ago than the timeout, the
 * first watchdog tick will immediately mark it unavailable.
 *
 * @version 3.0.0
 */

// ─────────────────────────────────────────────────────────────────────────────
// Static trigger helper (backward-compatible with all existing drivers)
// ─────────────────────────────────────────────────────────────────────────────

class AvailabilityManager {
  /**
   * Fire the appropriate availability flow trigger card.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {boolean} available
   */
  static trigger(device, available) {
    const cardId = available ? 'availability_turned_on' : 'availability_turned_off';
    device.log(`[AvailabilityManager] Firing flow: ${cardId}`);

    // getTimezone() is synchronous in Homey SDK v3+ — returns a string directly.
    let tz = 'UTC';
    try {
      const result = device.homey.clock.getTimezone();
      if (typeof result === 'string' && result.length > 0) tz = result;
    } catch { /* use UTC fallback */ }

    const timestamp = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());

    const tokens = { device_name: device.getName(), timestamp };

    // state must be { device } so the flow card's device picker can match.
    device.homey.flow.getTriggerCard(cardId)
      .trigger(tokens, { device })
      .catch(err => device.error(`[AvailabilityManager] ${cardId} trigger failed:`, err.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base
// ─────────────────────────────────────────────────────────────────────────────

class AvailabilityManagerBase {

  /**
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {object} options
   * @param {number} options.timeout          - Inactivity timeout in ms
   * @param {number} [options.checkInterval]  - Watchdog tick in ms (default 60s)
   */
  constructor(device, options = {}) {
    if (!device) throw new Error('[Availability] device is required');
    if (!options.timeout || options.timeout <= 0) throw new Error('[Availability] timeout must be positive');

    this.device = device;
    this.options = { checkInterval: 60 * 1000, ...options };
    this._watchdogInterval = null;
    this._installed = false;
    this._frameHookInstalled = false;
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  /**
   * Record activity: persist timestamp, restore availability if lost.
   * @param {string} source - Log label (e.g. 'cluster 0xef00', 'reporting')
   */
  async _markAlive(source) {
    try {
      await this.device.setStoreValue('last_seen_ts', Date.now()).catch(() => {});

      // _restoring guard prevents double-fire when multiple frames arrive simultaneously
      // (e.g. ep1 + ep2 both trigger _markAlive before setAvailable() resolves)
      if (!this.device.getAvailable() && !this._restoring) {
        this._restoring = true;
        this.device.log(`[Availability] Restoring (${source})`);
        await this._markAllAvailable().finally(() => { this._restoring = false; });
      }
    } catch (err) {
      this._restoring = false;
      this.device.error('[Availability] _markAlive error:', err.message);
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  _startWatchdog() {
    this._stopWatchdog();
    this.device.log('[Availability] Watchdog starting...');
 
    this._watchdogInterval = this.device.homey.setInterval(async () => {
      try {
        const lastSeen = this.device.getStoreValue('last_seen_ts') ?? null;

        if (!lastSeen) {
          // First run — seed the timestamp so the next tick has a baseline
          await this.device.setStoreValue('last_seen_ts', Date.now()).catch(() => {});
          return;
        }

        const idle    = Date.now() - lastSeen;
        const idleMin = Math.round(idle / 60000);

        // Log idle progress every 5 min to reduce noise
        if (idleMin > 0 && idleMin % 5 === 0) {
          this.device.log(`[Availability] Idle: ${idleMin}min / ${Math.round(this.options.timeout / 60000)}min`);
        }

        if (this.device.getAvailable() && idle > this.options.timeout) {
          this.device.log(`[Availability] Timeout — no activity for ${idleMin}min`);
          await this._markAllUnavailable(`No activity for ${idleMin}min`);
        }
      } catch (err) {
        this.device.error('[Availability] Watchdog error:', err.message);
      }
    }, this.options.checkInterval);
  }

  _stopWatchdog() {
    if (this._watchdogInterval) {
      this.device.homey.clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
      this.device.log('[Availability] Watchdog stopped');
    }
  }

  // ── Sibling cascade ───────────────────────────────────────────────────────

  /**
   * Mark all sibling devices available.
   * Sets is_availability=true AFTER setAvailable() so Homey fires the
   * capability-based flow trigger ("is_availability turns on") on an
   * already-available device.
   */
  async _markAllAvailable() {
    const wasUnavailable = !this.device.getAvailable();
    const changed = this._getSiblings().filter(s => !s.getAvailable());

    // 1. Restore availability state
    await Promise.allSettled(
      changed.map(s => {
        s.log('[Availability] Available');
        return s.setAvailable().catch(() => {});
      })
    );

    // 2. Update is_availability on main device only → fires "turns on" flow trigger.
    //    All siblings show the availability triangle via setAvailable/setUnavailable above.
    if (this.device.hasCapability('is_availability')) {
      await this.device.setCapabilityValue('is_availability', true).catch(() => {});
    }

    // Legacy: fire trigger once for the main device only (not per sibling)
    AvailabilityManager.trigger(this.device, true);

    if (wasUnavailable && typeof this.device.onBecameAvailable === 'function') {
      try {
        await this.device.onBecameAvailable();
      } catch (err) {
        this.device.error('[Availability] onBecameAvailable error:', err.message);
      }
    }
  }

  /**
   * Mark all sibling devices unavailable.
   * Sets is_availability=false BEFORE setUnavailable() so Homey fires the
   * capability-based flow trigger ("is_availability turns off") while the
   * device is still available (ensuring the trigger fires).
   * @param {string} reason
   */
  async _markAllUnavailable(reason) {
    const wasAvailable = this.device.getAvailable();
    const changed = this._getSiblings().filter(s => s.getAvailable());

    // 1. Update is_availability BEFORE marking unavailable → fires "turns off" flow trigger.
    //    Only on the main device (this.device = Gang 1 / EP1).
    if (this.device.hasCapability('is_availability')) {
      await this.device.setCapabilityValue('is_availability', false).catch(() => {});
    }

    // 2. Mark all unavailable
    await Promise.allSettled(
      changed.map(s => {
        s.log(`[Availability] Unavailable: ${reason}`);
        return s.setUnavailable(reason).catch(() => {});
      })
    );

    // Legacy: fire trigger once for the main device only (not per sibling)
    AvailabilityManager.trigger(this.device, false);

    if (wasAvailable && typeof this.device.onBecameUnavailable === 'function') {
      try {
        await this.device.onBecameUnavailable(reason);
      } catch (err) {
        this.device.error('[Availability] onBecameUnavailable error:', err.message);
      }
    }
  }

  /**
   * Resolve all Homey device instances sharing this physical Zigbee node.
   * Strategy: 1) ieeeAddress  2) token  3) self only
   */
  _getSiblings() {
    try {
      const myData  = this.device.getData();
      const myIeee  = myData?.ieeeAddress;
      const myToken = myData?.token;
      const all     = this.device.driver.getDevices();

      if (myIeee) {
        const byIeee = all.filter(d => { try { return d.getData().ieeeAddress === myIeee; } catch { return false; } });
        if (byIeee.length > 0) return byIeee;
      }

      if (myToken) {
        const byToken = all.filter(d => { try { return d.getData().token === myToken; } catch { return false; } });
        if (byToken.length > 0) return byToken;
      }

      return [this.device];
    } catch (err) {
      this.device.error('[Availability] _getSiblings error:', err.message);
      return [this.device];
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async uninstall() {
    if (!this._installed) return;
    this._stopWatchdog();
    await this._cleanup();
    this._installed = false;
    this.device.log('[Availability] Uninstalled');
  }

  /** Initialise is_availability to true on boot (device is online at startup). */
  _initAlarmCapability() {
    if (this.device.hasCapability('is_availability')) {
      this.device.setCapabilityValue('is_availability', true).catch(() => {});
    }
  }

  /** @protected Override in subclass for additional cleanup */
  async _cleanup() {}

  /** @abstract */
  async install() {
    throw new Error('install() must be implemented by subclass');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster0 — passive handleFrame hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hooks node.handleFrame to intercept ALL inbound Zigbee frames.
 * Use for: mains-powered devices (smart plugs, switches, power strips)
 * where every poll response, attribute report and keepalive should count.
 *
 * The original handler is always called — cluster processing is unaffected.
 */
class AvailabilityManagerCluster0 extends AvailabilityManagerBase {

  async install() {
    if (this._installed) { this.device.error('[Availability] Already installed'); return; }

    try {
      await this._installHandleFrameHook();
      await this.device.setStoreValue('last_seen_ts', Date.now()).catch(() => {});
      this._initAlarmCapability();
      this._startWatchdog();
      this._installed = true;
      this.device.log('[Availability] Passive monitoring enabled (Cluster0)');
    } catch (err) {
      this.device.error('[Availability] Installation failed:', err.message);
      throw err;
    }
  }

  async _installHandleFrameHook() {
    const node = await this.device.homey.zigbee.getNode(this.device);
    if (!node) throw new Error('[Availability] Failed to get ZigBee node');
 
    if (node._availabilityHookInstalled) {
      this.device.log('[Availability] node.handleFrame already hooked (shared node)');
      return;
    }
 
    const original = node.handleFrame;
    if (typeof original !== 'function') {
      // If no handler exists, we just record activity and return
      node.handleFrame = async (endpointId, clusterId, frame, meta) => {
        await this._markAlive(`ep${endpointId} cl:0x${clusterId.toString(16)}`).catch(() => {});
        return false;
      };
    } else {
      // Wrap the existing handler. Note: node is shared by all sub-devices.
      node.handleFrame = async (endpointId, clusterId, frame, meta) => {
        try {
          await this._markAlive(`ep${endpointId} cl:0x${clusterId.toString(16)}`);
        } catch (e) {
          this.device.error('[Availability] handleFrame hook error:', e.message);
        }
        return original.call(node, endpointId, clusterId, frame, meta);
      };
    }
 
    node._availabilityHookInstalled = true;
    this._frameHookInstalled = true;
    this.device.log('[Availability] handleFrame hook installed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster6 — callback-driven (battery-powered sensors)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injects device._markAliveFromAvailability(source) for explicit signalling.
 * Use for: battery devices (temp/humidity sensors) where handleFrame access
 * may not be available or is unreliable.
 *
 * The device must call this._markAliveFromAvailability?.('source') in every
 * inbound data handler (reportParser, Tuya 'reporting'/'response'/'heartbeat').
 */
class AvailabilityManagerCluster6 extends AvailabilityManagerBase {

  async install() {
    if (this._installed) { this.device.error('[Availability] Already installed'); return; }

    try {
      this.device._markAliveFromAvailability = async (source = 'activity') => {
        await this._markAlive(source);
      };
      await this.device.setStoreValue('last_seen_ts', Date.now()).catch(() => {});
      this._initAlarmCapability();
      this._startWatchdog();
      this._installed = true;
      this.device.log('[Availability] Monitoring enabled (Cluster6)');
    } catch (err) {
      this.device.error('[Availability] Installation failed:', err.message);
      throw err;
    }
  }

  async _cleanup() {
    delete this.device._markAliveFromAvailability;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

// Default export: static trigger helper (backward-compatible)
// Named exports: class-based managers
module.exports = AvailabilityManager;
module.exports.AvailabilityManagerCluster0 = AvailabilityManagerCluster0;
module.exports.AvailabilityManagerCluster6 = AvailabilityManagerCluster6;
