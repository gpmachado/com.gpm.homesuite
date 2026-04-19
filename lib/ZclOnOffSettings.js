'use strict';

const POWER_ON_MAP     = { 0: 'off', 1: 'on', 2: 'lastState' };
const POWER_ON_DISPLAY = { off: 'Always Off', on: 'Always On', lastState: 'Last State' };
const INDICATOR_MAP    = { 0: 'off', 1: 'status', 2: 'position' };

/**
 * Normalize powerOnStateGlobal: uint8 (0/1/2) or enum string → 'off'/'on'/'lastState'.
 * @param {number|string} value
 * @returns {string}
 */
function normalizePowerOnState(value) {
  return (typeof value === 'string') ? value : (POWER_ON_MAP[value] ?? String(value));
}

/**
 * Convert powerOnState enum string or uint8 → raw uint8 (for ZCL write).
 * @param {string|number} v
 * @returns {number}
 */
function toRawPowerOn(v) {
  if (typeof v === 'number') return v;
  return { off: 0, on: 1, lastState: 2 }[v] ?? 2;
}

/**
 * Normalize indicatorMode: uint8 (0/1/2) or enum string → 'off'/'status'/'position'.
 * @param {number|string} value
 * @returns {string}
 */
function normalizeIndicatorMode(value) {
  return (typeof value === 'string') ? value : (INDICATOR_MAP[value] ?? String(value));
}

module.exports = {
  POWER_ON_MAP,
  POWER_ON_DISPLAY,
  INDICATOR_MAP,
  normalizePowerOnState,
  toRawPowerOn,
  normalizeIndicatorMode,
};
