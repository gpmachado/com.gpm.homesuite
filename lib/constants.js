'use strict';

// Single source of truth — matches app.json "version" field.
const { version: APP_VERSION } = require('../app.json');

module.exports = {

  APP_VERSION,

  // ── Availability watchdog timeouts ────────────────────────────────────────
  // Time without any Zigbee frame before a device is marked unavailable.

  // Mains-powered switches (TS0001/TS0002/TS0003/TS0004/6-gang, moes dimmer).
  // These send periodic reports; 5 min gives one missed report cycle before alert.
  // TODO: raise to 20 min for production (covers 2× missed report cycles at 10 min interval)
  // Switches with cluster 6 (onOff) — receive attribute reports every ≤10 min.
  HEARTBEAT_TIMEOUT_MS: 25 * 60 * 1000,           // 25 min (2.5× 10 min report interval)

  // Switches using Tuya cluster 61184 only (4-gang, 6-gang) — no cluster 6 attribute reports.
  // Tuya heartbeat arrives every 30-60 min; 90 min covers worst case.
  TUYA_HEARTBEAT_TIMEOUT_MS: 90 * 60 * 1000,      // 90 min

  // ZCL attribute reporting — max interval for all onOff clusters (switches, plugs, strip).
  // Device will send at least one report every 10 min even if state has not changed.
  ONOFF_REPORT_MAX_INTERVAL_S: 600,               // 10 min (in seconds — ZCL unit)

  // Power strip — sends fewer keepalives and may be in standby for long periods.
  SOCKET_POWER_STRIP_TIMEOUT_MS: 25 * 60 * 1000, // 25 min (2.5× 10 min report interval)

  // Smart plug (TS011F) — AC-powered with active polling; 10 min covers 5 missed poll cycles.
  SMART_PLUG_TIMEOUT_MS:          25 * 60 * 1000, // 25 min (2.5× 10 min report interval)
  SMART_PLUG_POLL_MIN_MS:          2 * 60 * 1000, //  2 min — base poll interval
  SMART_PLUG_POLL_MAX_MS:         15 * 60 * 1000, // 15 min — backoff cap
  SMART_PLUG_VOLTAGE_POLL_EVERY:  5,              // rmsVoltage every 5 cycles  (~10 min)
  SMART_PLUG_ENERGY_POLL_EVERY:  10,              // kWh       every 10 cycles  (~20 min)

  // Smart plug — ElectricalMeasurement configureAttributeReporting defaults.
  // TS011F variants reject maxInterval < 60 s (returns invalid_max_interval_value).
  // Voltage is stable; a longer default interval reduces mesh traffic.
  SMART_PLUG_REPORT_POWER_DEFAULT_S:    60,   // activePower  — default & minimum
  SMART_PLUG_REPORT_CURRENT_DEFAULT_S:  60,   // rmsCurrent   — default & minimum
  SMART_PLUG_REPORT_VOLTAGE_DEFAULT_S: 300,   // rmsVoltage   — default (minimum = 60 s)
  SMART_PLUG_REPORT_INTERVAL_MIN_S:     60,   // hard floor accepted by device

  // Battery / sleepy end devices (LCD temp/humid sensor, SNZB-0x motion/contact).
  // These wake every few minutes; a longer window avoids false offline alerts.
  BATTERY_DEVICE_HEARTBEAT_MS: 4 * 60 * 60 * 1000,  // 4 h

  // Tuya temp/humidity clock (end device, sleepy).
  // Wakes on state change or heartbeat; may be silent for hours in stable conditions.
  // 12 h covers worst-case stable-environment sleep cycles.
  TEMPHUMID_CLOCK_HEARTBEAT_MS: 12 * 60 * 60 * 1000, // 12 h

  // Gas detector (IAS Zone, mains-powered) — only sends frames on alarm or keepalive.
  // Silent when idle; 4 h window covers expected basic cluster report cycles.
  GAS_DETECTOR_HEARTBEAT_MS:   4 * 60 * 60 * 1000, // 4 h = 240 min

  // Sonoff mains-powered devices (BASICZBR3, ZBMINIR2).
  // Onoff reporting every 1 h max; 90 min gives 1.5× the reporting interval as buffer.
  SONOFF_HEARTBEAT_TIMEOUT_MS: 90 * 60 * 1000,       // 90 min
  SONOFF_REPORT_MAX_INTERVAL_S: 3600,                 // 60 min (Sonoff slower than TS111F)

  // Sonoff DONGLE-E_R — cluster 6 (onOff) configured with maxInterval 300s (5 min).
  // 15 min = 3× the reporting interval as safety buffer.
  SONOFF_DONGLE_HEARTBEAT_MS: 15 * 60 * 1000,        // 15 min

};
