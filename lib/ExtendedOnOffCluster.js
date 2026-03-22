// tuya-on-off-cluster.js
'use strict';

const { ZCLDataTypes, OnOffCluster, Cluster } = require('zigbee-clusters');

/**
 * @enum {number}
 * @description LED backlight on/off.
 * CRITICAL: Must match the ZCL attribute type (0x30 = enum8).
 * Devices verify the type byte in Write Attributes — sending uint8 (0x20)
 * is silently ignored even though the device ACKs the write.
 */
const enum8BacklightControl = ZCLDataTypes.enum8({
  off: 0x00,
  on:  0x01,
});

/**
 * @enum {number}
 * @description LED indicator behavior for smart plugs.
 * - off      (0x00): Indicator always off
 * - status   (0x01): Indicator reflects relay state (on=lit, off=dark)
 * - position (0x02): Indicator reflects inverse of relay state
 */
ZCLDataTypes.enum8IndicatorMode = ZCLDataTypes.enum8({
  off:      0x00,
  status:   0x01,
  position: 0x02,
});

/**
 * @enum {number}
 * @description Global power-on behavior after mains power loss/restore.
 * Applies simultaneously to ALL gangs on multi-endpoint devices.
 * Use TuyaPowerOnStateCluster.powerOnStateGang for per-gang control.
 * - off       (0x00): All relays stay off after power restore
 * - on        (0x01): All relays turn on after power restore
 * - lastState (0x02): All relays restore state before power loss
 */
ZCLDataTypes.enum8PowerOnStateGlobal = ZCLDataTypes.enum8({
  off:       0x00,
  on:        0x01,
  lastState: 0x02,
});

/**
 * Tuya-extended OnOff cluster (0x0006).
 *
 * Extends the standard ZCL OnOff cluster with Tuya-specific attributes
 * found on wall switches and smart plugs (TS0001, TS0002, TS0003, etc.).
 *
 * CRITICAL: Must be registered via `Cluster.addCluster()` before device
 * initialisation. Without registration the framework cannot parse Tuya
 * vendor attributes in `reportAttributes` frames, which produces
 * state cross-talk between gangs on multi-endpoint devices.
 *
 * Global vs per-gang power-on behavior:
 * - `powerOnStateGlobal` (this cluster, 0x8002): sets ALL gangs at once
 * - `powerOnStateGang`   (0xE001, 0xD010):       sets ONE gang per endpoint
 *
 * Attribute map:
 * | Name                | ID     | Type                    | Description                      |
 * |---------------------|--------|-------------------------|----------------------------------|
 * | onOff               | 0x0000 | bool                    | Standard ZCL on/off state        |
 * | onTime              | 0x4001 | uint16                  | Countdown — write with offWaitTime |
 * | offWaitTime         | 0x4002 | uint16                  | Countdown — write with onTime    |
 * | backlightControl    | 0x5000 | bool                    | LED backlight on/off             |
 * | childLock           | 0x8000 | bool                    | Physical button lock             |
 * | indicatorMode       | 0x8001 | enum8IndicatorMode      | LED indicator behaviour          |
 * | powerOnStateGlobal  | 0x8002 | enum8PowerOnStateGlobal | Global power-on restore behavior |
 *
 * Countdown / inching mode:
 *   Tuya firmware requires `onTime` (0x4001) and `offWaitTime` (0x4002) to be
 *   written with the same value (seconds). Use `setCountdown()` to enforce this.
 *   Example — 10 s: `setCountdown(10)`  |  Disable: `setCountdown(0)`
 *
 * @extends OnOffCluster
 */
class ExtendedOnOffCluster extends OnOffCluster {

  /** @returns {number} Cluster ID: 6 (OnOff) */
  static get ID() {
    return 6;
  }

  /** @returns {string} Logical cluster name */
  static get NAME() {
    return 'onOff';
  }

  /**
   * Cluster attribute definitions.
   * Merges standard OnOff attributes with Tuya vendor extensions.
   * @returns {object}
   */
  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,

      /**
       * Tuya On Time — countdown timer (0x4001 / 16385).
       * Seconds until auto-off after the relay turns ON.
       * MUST be written together with `offWaitTime` using the same value.
       * Set to 0 to disable.
       * @type {number} uint16  range: 0–65535
       */
      onTime: {
        id:   0x4001,
        type: ZCLDataTypes.uint16,
      },

      /**
       * Tuya Off Wait Time — countdown timer (0x4002 / 16386).
       * Seconds until auto-off after the relay turns ON.
       * MUST be written together with `onTime` using the same value.
       * Set to 0 to disable.
       * @type {number} uint16  range: 0–65535
       */
      offWaitTime: {
        id:   0x4002,
        type: ZCLDataTypes.uint16,
      },

      /**
       * LED backlight toggle (0x5000 / 20480).
       * Controls the physical backlight behind the rocker on wall switches.
       *
       * Type: 0x30 (enum8) — MUST use enum8, not uint8.
       * Devices check the ZCL attribute type byte in Write Attributes;
       * uint8 (0x20) writes are silently accepted but physically ignored.
       * Values: 'off' (0x00) / 'on' (0x01)
       */
      backlightControl: {
        id:   0x5000,
        type: enum8BacklightControl,
      },

      /**
       * Physical button lock (0x8000 / 32768).
       * When `true`, pressing the physical rocker has no effect.
       * Type: 0x20 (uint8)
       * @type {number}
       */
      childLock: {
        id:   0x8000,
        type: ZCLDataTypes.uint8,
      },

      /**
       * LED indicator mode (0x8001 / 32769).
       * Controls when and how the status LED lights up.
       * Primarily found on smart plugs.
       * Type: 0x20 (uint8)
       * 0x00 -> 'off', 0x01 -> 'status', 0x02 -> 'position'
       * @type {number}
       */
      indicatorMode: {
        id:   0x8001,
        type: ZCLDataTypes.uint8,
      },

      /**
       * Global power-on restore behavior (0x8002 / 32770).
       * Applies simultaneously to ALL gangs on multi-endpoint devices.
       * Type: 0x30 (enum8) — MUST use enum8, not uint8.
       * Devices check the ZCL attribute type byte in Write Attributes;
       * uint8 (0x20) writes are silently accepted but physically ignored.
       * Values: 'off' (0x00) / 'on' (0x01) / 'lastState' (0x02)
       */
      powerOnStateGlobal: {
        id:   0x8002,
        type: ZCLDataTypes.enum8PowerOnStateGlobal,
      },

      /**
       * Sonoff power-on behavior (0x4003 / startUpOnOff — ZCL 8 standard attr).
       * Used by ZBMINIR2 and other Sonoff devices.
       * Values: 'off' (0) / 'on' (1) / 'toggle' (2) / 'last_state' (255)
       */
      powerOnBehavior: {
        id:   0x4003,
        type: ZCLDataTypes.enum8({
          off:        0,
          on:         1,
          toggle:     2,
          last_state: 255,
        }),
      },
    };
  }

  // ─────────────────────────────────────────────
  // Read helpers
  // ─────────────────────────────────────────────

  /**
   * Read all Tuya vendor attributes in a single ZCL request.
   *
   * Call in `onNodeInit()` and in the rejoin handler to synchronise the
   * full attribute state. Attributes unsupported by older firmware are
   * skipped silently.
   *
   * @returns {Promise<{
   *   onOff?:             boolean,
   *   onTime?:            number,
   *   offWaitTime?:       number,
   *   backlightControl?:  boolean,
   *   childLock?:         boolean,
   *   indicatorMode?:     'off'|'status'|'position',
   *   powerOnStateGlobal?:'off'|'on'|'lastState'
   * }>} Resolved attribute map (absent keys = not supported by device).
   *
   * @example
   * const state = await zclNode.endpoints[1].clusters.onOff.readTuyaAttributes();
   * // { onOff: true, powerOnStateGlobal: 'lastState', childLock: false, ... }
   */
  async readTuyaAttributes() {
    return this.readAttributes([
      'onOff',
      'onTime',
      'offWaitTime',
      'backlightControl',
      'childLock',
      'indicatorMode',
      'powerOnStateGlobal',
    ]).catch(err => {
      this.emit('error', new Error(`ExtendedOnOffCluster.readTuyaAttributes — ${err.message}`));
      return {};
    });
  }

  // ─────────────────────────────────────────────
  // Write helpers
  // ─────────────────────────────────────────────

  /**
   * Set global power-on restore behavior for ALL gangs simultaneously.
   * For per-gang control use TuyaPowerOnStateCluster.setGangPowerOnState().
   *
   * @param {'off'|'on'|'lastState'} value
   * @returns {Promise<void>}
   * @throws {TypeError} When an unknown value is supplied.
   *
   * @example
   * await cluster.setGlobalPowerOnState('lastState');
   */
  async setGlobalPowerOnState(value) {
    // Write the enum8 string value ('off'/'on'/'lastState') — NOT a numeric 0/1/2.
    // The ZCL frame type must be 0x30 (enum8); uint8 (0x20) writes are
    // silently accepted by Tuya firmware but physically ignored.
    const valid = ['off', 'on', 'lastState'];
    const val = valid.includes(value) ? value : 'lastState';
    return this.writeAttributes({ powerOnStateGlobal: val });
  }

  /**
   * Enable or disable countdown / inching mode.
   *
   * Tuya firmware requires `onTime` (0x4001) and `offWaitTime` (0x4002) to
   * carry the same value. This helper enforces that invariant.
   *
   * @param {number} seconds  Duration in seconds (0 = disable, 1–65535 = active).
   * @returns {Promise<void>}
   * @throws {RangeError} When `seconds` is outside the 0–65535 range.
   *
   * @example
   * await cluster.setCountdown(30);  // auto-off after 30 s
   * await cluster.setCountdown(0);   // disable countdown
   */
  async setCountdown(seconds) {
    if (typeof seconds !== 'number' || seconds < 0 || seconds > 0xFFFF) {
      throw new RangeError(
        `ExtendedOnOffCluster.setCountdown — seconds must be 0–65535, got: ${seconds}`
      );
    }
    return this.writeAttributes({ onTime: seconds, offWaitTime: seconds });
  }

  /**
   * Lock or unlock the physical rocker button.
   *
   * @param {boolean} locked  `true` to lock, `false` to unlock.
   * @returns {Promise<void>}
   *
   * @example
   * await cluster.setChildLock(true);
   */
  async setChildLock(locked) {
    return this.writeAttributes({ childLock: locked ? 1 : 0 });
  }

  /**
   * Set LED indicator mode.
   *
   * @param {'off'|'status'|'position'} value
   * @returns {Promise<void>}
   * @throws {TypeError} When an unknown value is supplied.
   *
   * @example
   * await cluster.setIndicatorMode('status');
   */
  async setIndicatorMode(value) {
    const enumToInt = { off: 0, status: 1, position: 2 };
    const val = enumToInt[value] ?? (typeof value === 'number' ? value : 1);
    return this.writeAttributes({ indicatorMode: val });
  }

  /**
   * Toggle LED backlight.
   *
   * Writes the enum8 string value ('on'/'off') — NOT a numeric 0/1.
   * The ZCL frame type must be 0x30 (enum8); uint8 (0x20) writes are
   * silently accepted by Tuya firmware but physically ignored.
   *
   * @param {boolean} on  `true` to enable backlight, `false` to disable.
   * @returns {Promise<void>}
   *
   * @example
   * await cluster.setBacklight(false);
   */
  async setBacklight(on) {
    return this.writeAttributes({ backlightControl: on ? 'on' : 'off' });
  }
}

// CRITICAL: Register the extended cluster before any device initialisation.
// Without this, the ZCL parser falls back to the base OnOff cluster and
// cannot decode vendor attribute IDs, causing state cross-talk on
// multi-gang devices (TS0002, TS0003, etc.).
Cluster.addCluster(ExtendedOnOffCluster);

module.exports = ExtendedOnOffCluster;