'use strict';

// Single source of truth — matches app.json "version" field.
const { version: APP_VERSION } = require('../app.json');

module.exports = {

  APP_VERSION,

  // ── Debug ──────────────────────────────────────────────────────────────────
  // true  -> verbose zigbee-clusters frame logging and extra app-side ZCL diagnostics.
  // false -> production logging.
  ZCL_DEBUG: false,

  // ── Availability watchdog timeouts ────────────────────────────────────────
  // Time without any Zigbee frame before a device is marked unavailable.
  // Named by expected silence tolerance, not by device brand — any device
  // whose reporting cadence fits a tier uses that tier, regardless of family.

  // Fast tier — mains-powered devices with active onOff/cluster-6 reporting
  // every ≤10 min (switches, power strip, smart plug). 2.5× the report interval.
  HEARTBEAT_FAST_MS: 25 * 60 * 1000, // 25 min

  // Medium tier — mains-powered devices with slower or heartbeat-only reporting:
  // Tuya-cluster-only switches (heartbeat every 30-60 min), Sonoff onOff
  // (hourly), Zigbee repeater (30 min active ping, no spontaneous frames).
  HEARTBEAT_MEDIUM_MS: 90 * 60 * 1000, // 90 min

  // Slow tier — any device legitimately silent for hours: battery/sleepy end
  // devices (LCD temp/humid sensor, SNZB-0x motion/contact, door/window
  // sensor) and mains-powered IAS Zone devices that only report on alarm or
  // keepalive (gas detector). Grouped by silence tolerance, not power source.
  HEARTBEAT_SLOW_MS: 4 * 60 * 60 * 1000, // 4 h

  // Very slow tier — longest-tolerance sleepy device (Tuya temp/humidity clock).
  HEARTBEAT_VERY_SLOW_MS: 12 * 60 * 60 * 1000, // 12 h

  // Sonoff DONGLE-E_R — cluster 6 (onOff) configured with maxInterval 300s (5 min).
  // Kept distinct: no other device shares this cadence. 15 min = 3× the reporting
  // interval as safety buffer.
  SONOFF_DONGLE_HEARTBEAT_MS: 15 * 60 * 1000,        // 15 min

  // ZCL attribute reporting — max interval for all onOff clusters (switches, plugs, strip).
  // Device will send at least one report every 10 min even if state has not changed.
  ONOFF_REPORT_MAX_INTERVAL_S: 600,               // 10 min (in seconds — ZCL unit)

  // Smart plug (TS011F) — AC-powered with active polling; 10 min covers 5 missed poll cycles.
  SMART_PLUG_POLL_MIN_MS:          2 * 60 * 1000, //  2 min — base poll interval
  SMART_PLUG_POLL_MAX_MS:         15 * 60 * 1000, // 15 min — backoff cap
  SMART_PLUG_VOLTAGE_POLL_EVERY:  5,              // rmsVoltage every 5 cycles  (~10 min)
  SMART_PLUG_ENERGY_POLL_EVERY:  10,              // kWh       every 10 cycles  (~20 min)

  // Sonoff mains-powered devices (BASICZBR3, ZBMINIR2).
  // Onoff reporting every 1 h max; 90 min gives 1.5× the reporting interval as buffer.
  SONOFF_REPORT_MAX_INTERVAL_S: 3600,                 // 60 min (Sonoff slower than TS111F)

  // Zigbee repeater (TS0207) — no spontaneous ZCL frames after init.
  // Active ping every 30 min (read basic 0x0004); 90 min = 3× ping interval.
  // Matches Hubitat's recovery threshold for router devices.
  ZIGBEE_REPEATER_PING_INTERVAL_MS: 30 * 60 * 1000,  // 30 min

  // Door & window sensor (TS0203, IAS Zone, battery CR2032).
  // Field-tested: configureAttributeReporting on battery is accepted (SUCCESS)
  // but this firmware never sends the periodic report — confirmed by an ~11 h
  // silent gap in production logs despite a 1 h configured maxInterval.
  // Heartbeat is therefore driven by active readAttributes polling, not by
  // waiting for the device to report on its own — see drivers/doorwindowsensor/device.js.
  DOOR_SENSOR_POLL_INTERVAL_MS: 30 * 60 * 1000,      // 30 min — active battery readAttributes

  // ── Poll antes de marcar offline ──────────────────────────────────────────

  POLL_BEFORE_OFFLINE: true,
  POLL_TIMEOUT_MS: 10000,

  // Espalha o instante do poll de confirmação entre 0 e este valor.
  // Evita que vários dispositivos expirando no mesmo tick do watchdog
  // (ex.: queda de energia geral seguida de reconexão simultânea) disputem
  // o canal Zigbee ao mesmo tempo com readAttributes concorrentes.
  POLL_JITTER_MAX_MS: 5000, // 5 s

};
