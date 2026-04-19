'use strict';

// ── Raw → enum maps ───────────────────────────────────────────────────────────
const POWER_ON_MAP  = { 0: 'off', 1: 'on', 2: 'lastState' };
const INDICATOR_MAP = { 0: 'off', 1: 'status', 2: 'position' };

// ── Enum → display label maps ─────────────────────────────────────────────────
const POWER_ON_DISPLAY  = { off: 'Always Off', on: 'Always On', lastState: 'Last State' };
const INDICATOR_LABELS  = { off: 'Always off', status: 'On when powered', position: 'Off when powered' };

// ── Normalize ─────────────────────────────────────────────────────────────────

/**
 * Normalize powerOnStateGlobal: uint8 (0/1/2) or enum string → 'off'/'on'/'lastState'.
 * Also handles 'memory' alias (some firmware) → 'lastState'.
 * @param {number|string} value
 * @returns {string}
 */
function normalizePowerOnState(value) {
  if (typeof value === 'number') return POWER_ON_MAP[value] ?? String(value);
  return value === 'memory' ? 'lastState' : value;
}

/**
 * Convert powerOnState enum string or uint8 → raw uint8 (for ZCL write).
 * @param {string|number} v
 * @returns {number}
 */
function toRawPowerOn(v) {
  if (typeof v === 'number') return v;
  return { off: 0, on: 1, lastState: 2, memory: 2 }[v] ?? 2;
}

/**
 * Normalize indicatorMode: uint8 (0/1/2) or enum string → 'off'/'status'/'position'.
 * @param {number|string} value
 * @returns {string}
 */
function normalizeIndicatorMode(value) {
  if (typeof value === 'number') return INDICATOR_MAP[value] ?? String(value);
  return ['off', 'status', 'position'].includes(value) ? value : String(value);
}

// ── Label helpers ─────────────────────────────────────────────────────────────

/**
 * Human-readable label for a powerOnState value.
 * @param {number|string} value
 * @returns {string}
 */
function getPowerOnLabel(value) {
  const normalized = normalizePowerOnState(value);
  return POWER_ON_DISPLAY[normalized] ?? String(normalized);
}

/**
 * Human-readable label for an indicatorMode value.
 * @param {number|string} value
 * @returns {string}
 */
function getIndicatorModeLabel(value) {
  const normalized = normalizeIndicatorMode(value);
  return INDICATOR_LABELS[normalized] ?? String(normalized);
}

// ── Settings patch helpers ────────────────────────────────────────────────────

/**
 * Build a setSettings patch object for a powerOnState change.
 * @param {string}        behaviorKey  - dropdown setting key  (e.g. 'power_on_behavior_global')
 * @param {string|null}   currentKey   - label   setting key  (e.g. 'power_on_current_global'), or null
 * @param {number|string} value        - raw or normalized value from device/UI
 * @returns {object}
 */
function powerOnSettingsPatch(behaviorKey, currentKey, value) {
  const normalized = normalizePowerOnState(value);
  const patch = { [behaviorKey]: normalized };
  if (currentKey) patch[currentKey] = POWER_ON_DISPLAY[normalized] ?? normalized;
  return patch;
}

/**
 * Build a setSettings patch object for an indicatorMode change.
 * @param {string}        modeKey     - enum    setting key (e.g. 'indicator_mode')
 * @param {string|null}   currentKey  - label   setting key (e.g. 'indicator_mode_current'), or null
 * @param {number|string} value       - raw or normalized value from device/UI
 * @returns {object}
 */
function indicatorSettingsPatch(modeKey, currentKey, value) {
  const normalized = normalizeIndicatorMode(value);
  const patch = { [modeKey]: normalized };
  if (currentKey) patch[currentKey] = INDICATOR_LABELS[normalized] ?? normalized;
  return patch;
}

// ── Reporting jitter ──────────────────────────────────────────────────────────

/**
 * Apply random jitter to a reporting interval to prevent mesh congestion
 * when many devices restart/rejoin simultaneously.
 *
 * @param {number} baseSeconds     - base interval in seconds
 * @param {number} jitterPercent   - max variation ± as % of base (default 10)
 * @returns {number} interval in seconds, minimum 1
 */
function applyJitter(baseSeconds, jitterPercent = 10) {
  const variation = baseSeconds * (jitterPercent / 100);
  const offset    = (Math.random() * 2 - 1) * variation;
  return Math.max(1, Math.round(baseSeconds + offset));
}

module.exports = {
  // Maps
  POWER_ON_MAP,
  POWER_ON_DISPLAY,
  INDICATOR_MAP,
  INDICATOR_LABELS,
  // Normalize
  normalizePowerOnState,
  toRawPowerOn,
  normalizeIndicatorMode,
  // Labels
  getPowerOnLabel,
  getIndicatorModeLabel,
  // Settings patches
  powerOnSettingsPatch,
  indicatorSettingsPatch,
  // Reporting
  applyJitter,
};
