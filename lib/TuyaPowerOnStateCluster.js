// tuya-power-on-state-cluster.js
// v1.1.0 — Added D000-D003 attributes (confirmed via pcap decode, 2026-03-08).
'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * @enum {number}
 * @description Per-gang power-on behavior after mains power restore.
 * Controls each endpoint independently on multi-gang devices.
 * Use ExtendedOnOffCluster.powerOnStateGlobal for all-gangs-at-once control.
 * - off       (0x00): Relay stays off after power restore
 * - on        (0x01): Relay turns on after power restore
 * - lastState (0x02): Relay restores its state before power loss
 */
const enum8PowerOnStateGang = ZCLDataTypes.enum8({
  off:       0x00,
  on:        0x01,
  lastState: 0x02,
});

/**
 * @enum {number}
 * @description External switch/button wiring mode.
 * Defines how the physical input signal is interpreted by the relay.
 * - toggle    (0x00): Each pulse toggles the relay
 * - state     (0x01): Input level directly drives relay (on=on, off=off)
 * - momentary (0x02): Relay on only while button is held
 */
const enum8SwitchMode = ZCLDataTypes.enum8({
  toggle:    0x00,
  state:     0x01,
  momentary: 0x02,
});

/**
 * Tuya Private Cluster E001 (0xE001 / 57345) — per-gang power-on state.
 *
 * Controls power-on behavior individually per endpoint/gang, unlike the
 * global `powerOnStateGlobal` attribute (0x8002) in ExtendedOnOffCluster
 * (0x0006) which affects all gangs simultaneously.
 *
 * Present on every endpoint of multi-gang Tuya switches (TS0002, TS0003, …).
 *
 * Global vs per-gang power-on behavior:
 * - `ExtendedOnOffCluster.powerOnStateGlobal` (0x0006 / 0x8002): ALL gangs at once
 * - `TuyaPowerOnStateCluster.powerOnStateGang` (0xE001 / 0xD010): ONE gang per endpoint
 *
 * Attribute map:
 * | Name             | ID     | Type                 | Description                         |
 * |------------------|--------|----------------------|-------------------------------------|
 * | powerOnStateGang | 0xD010 | enum8PowerOnStateGang| Per-gang restore behavior           |
 * | tuyaMagic        | 0xD011 | uint8                | Tuya pairing magic byte (read-only) |
 * | switchMode       | 0xD030 | enum8SwitchMode      | External switch wiring type         |
 *
 * @extends Cluster
 */
class TuyaPowerOnStateCluster extends Cluster {

  /** @returns {number} Cluster ID: 0xE001 (57345) */
  static get ID() {
    return 0xE001;
  }

  /** @returns {string} Logical cluster name used by the Homey framework */
  static get NAME() {
    return 'tuyaPowerOnState';
  }

  /**
   * Cluster attribute definitions.
   * @returns {object}
   */
  static get ATTRIBUTES() {
    return {
      /**
       * Unknown Tuya E001 attribute (0xD000 / 53248).
       * Wire type: uint8 (0x20). Observed value: 0.
       * Present in the spontaneous Report Attributes burst on power-on.
       * Purpose undocumented — included to prevent parse errors.
       * @type {number} uint8
       */
      tuyaD000: {
        id:   0xD000,
        type: ZCLDataTypes.uint8,
      },

      /**
       * Inching / countdown time (0xD001 / 53249).
       * Wire type: bitmap32 (0x1b) — parsed as uint32 (same 4 bytes).
       * Must be declared here so the ZCL parser can advance past the
       * 4-byte value; without this entry the parser aborts with
       * "Invalid Type for Attribute 53249" and drops the rest of the frame.
       * Observed value: 0 (inching disabled).
       * @type {number} uint32 (raw 32-bit value)
       */
      tuyaD001: {
        id:   0xD001,
        type: ZCLDataTypes.uint32,
      },

      /**
       * Inching remaining time (0xD002 / 53250).
       * Wire type: uint32 (0x23). Observed value: 0.
       * @type {number} uint32
       */
      tuyaD002: {
        id:   0xD002,
        type: ZCLDataTypes.uint32,
      },

      /**
       * Unknown Tuya E001 attribute (0xD003 / 53251).
       * Wire type: uint32 (0x23). Observed value: 0.
       * @type {number} uint32
       */
      tuyaD003: {
        id:   0xD003,
        type: ZCLDataTypes.uint32,
      },

      /**
       * Per-gang power-on restore behavior (0xD010 / 53264).
       * Independent per endpoint — does not affect other gangs.
       * For all-gangs-at-once use ExtendedOnOffCluster.setGlobalPowerOnState().
       * @type {'off'|'on'|'lastState'}
       */
      powerOnStateGang: {
        id:   0xD010,
        type: enum8PowerOnStateGang,
      },

      /**
       * Tuya pairing magic byte (0xD011 / 53265).
       * Written by Tuya gateway during pairing. Treat as read-only —
       * writing an incorrect value may disrupt device pairing state.
       * @type {number} uint8
       */
      tuyaMagic: {
        id:   0xD011,
        type: ZCLDataTypes.uint8,
      },

      /**
       * External switch wiring mode (0xD030 / 53296).
       * Determines how the physical input signal drives the relay.
       * @type {'toggle'|'state'|'momentary'}
       */
      switchMode: {
        id:   0xD030,
        type: enum8SwitchMode,
      },
    };
  }

  /** @returns {object} No cluster-specific commands on this cluster. */
  static get COMMANDS() {
    return {};
  }

  // ─────────────────────────────────────────────
  // Read helpers
  // ─────────────────────────────────────────────

  /**
   * Read all E001 attributes in a single ZCL request.
   *
   * Call inside `onNodeInit()` and the rejoin handler to synchronise
   * per-gang state. Attributes unsupported by older firmware are skipped.
   *
   * @returns {Promise<{
   *   powerOnStateGang?: 'off'|'on'|'lastState',
   *   tuyaMagic?:        number,
   *   switchMode?:       'toggle'|'state'|'momentary'
   * }>} Resolved attribute map (absent keys = not supported by device).
   *
   * @example
   * const s = await zclNode.endpoints[1].clusters.tuyaPowerOnState.readAllAttributes();
   * // { powerOnStateGang: 'lastState', switchMode: 'toggle', tuyaMagic: 1 }
   */
  async readAllAttributes() {
    return this.readAttributes([
      'powerOnStateGang',
      'tuyaMagic',
      'switchMode',
    ]).catch(err => {
      this.emit('error', new Error(`TuyaPowerOnStateCluster.readAllAttributes — ${err.message}`));
      return {};
    });
  }

  // ─────────────────────────────────────────────
  // Write helpers
  // ─────────────────────────────────────────────

  /**
   * Set per-gang power-on restore behavior for this endpoint only.
   * For all-gangs-at-once use ExtendedOnOffCluster.setGlobalPowerOnState().
   *
   * @param {'off'|'on'|'lastState'} value  Desired behavior after power restore.
   * @returns {Promise<void>}
   * @throws {TypeError} When an unknown value is supplied.
   *
   * @example
   * // Endpoint 1 restores last state; endpoint 2 always turns off
   * await zclNode.endpoints[1].clusters.tuyaPowerOnState.setGangPowerOnState('lastState');
   * await zclNode.endpoints[2].clusters.tuyaPowerOnState.setGangPowerOnState('off');
   */
  async setGangPowerOnState(value) {
    const valid = ['off', 'on', 'lastState'];
    if (!valid.includes(value)) {
      throw new TypeError(
        `TuyaPowerOnStateCluster.setGangPowerOnState — invalid value "${value}". Expected: ${valid.join(', ')}`
      );
    }
    return this.writeAttributes({ powerOnStateGang: value });
  }

  /**
   * Set external switch wiring mode for this endpoint.
   *
   * @param {'toggle'|'state'|'momentary'} value  Wiring mode.
   * @returns {Promise<void>}
   * @throws {TypeError} When an unknown value is supplied.
   *
   * @example
   * await cluster.setSwitchMode('momentary');
   */
  async setSwitchMode(value) {
    const valid = ['toggle', 'state', 'momentary'];
    if (!valid.includes(value)) {
      throw new TypeError(
        `TuyaPowerOnStateCluster.setSwitchMode — invalid value "${value}". Expected: ${valid.join(', ')}`
      );
    }
    return this.writeAttributes({ switchMode: value });
  }
}

// CRITICAL: Register before device initialisation so the ZCL parser
// can decode cluster 0xE001 frames on rejoin and attribute reports.
Cluster.addCluster(TuyaPowerOnStateCluster);

module.exports = TuyaPowerOnStateCluster;