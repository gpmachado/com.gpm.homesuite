'use strict';

const POWER_ON_MAP  = { 0: 'off', 1: 'on', 2: 'lastState' };
const INDICATOR_MAP = { 0: 'off', 1: 'status', 2: 'position' };

/**
 * Normalize powerOnStateGlobal: uint8 (0/1/2) or enum string → 'off'/'on'/'lastState'.
 * @param {number|string} value
 * @returns {string}
 */
function normalizePowerOnState(value) {
  return (typeof value === 'string') ? value : (POWER_ON_MAP[value] ?? String(value));
}

/**
 * Normalize indicatorMode: uint8 (0/1/2) or enum string → 'off'/'status'/'position'.
 * @param {number|string} value
 * @returns {string}
 */
function normalizeIndicatorMode(value) {
  return (typeof value === 'string') ? value : (INDICATOR_MAP[value] ?? String(value));
}

module.exports = { normalizePowerOnState, normalizeIndicatorMode, POWER_ON_MAP, INDICATOR_MAP };
