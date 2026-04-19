'use strict';

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

/**
 * Read a single numeric setting safely, clamping to [min, max].
 * Does NOT persist — use safeGetNumberSettings (plural) when multiple
 * settings may be out of bounds simultaneously, since Homey validates
 * all settings on every setSettings() call.
 */
function safeGetNumberSetting(device, key, { min, max, fallback }) {
  let raw;
  try {
    raw = device.getSetting(key);
  } catch (err) {
    device.log(`[Settings] ${key} out of bounds in Homey store — using default (${fallback})`);
    raw = fallback;
  }
  return clampNumber(raw, { min, max, fallback });
}

/**
 * Read multiple numeric settings safely in one pass, then persist all
 * corrections in a single setSettings() call.
 *
 * Homey validates ALL settings on every setSettings() call, so correcting
 * them one-by-one fails when several are out of bounds simultaneously.
 *
 * @param {object} device - Homey device instance
 * @param {object} specs  - { settingKey: { min, max, fallback }, ... }
 * @returns {object}        { settingKey: correctedValue, ... }
 */
async function safeGetNumberSettings(device, specs) {
  const results = {};
  const corrections = {};

  for (const [key, opts] of Object.entries(specs)) {
    const clamped = safeGetNumberSetting(device, key, opts);
    results[key] = clamped;

    let raw;
    try { raw = device.getSetting(key); } catch { raw = undefined; }
    if (raw === undefined || String(raw) !== String(clamped)) {
      corrections[key] = clamped;
    }
  }

  if (Object.keys(corrections).length > 0) {
    await device.setSettings(corrections).catch(err => {
      device.log(`[Settings] Could not persist corrections (${Object.keys(corrections).join(', ')}): ${err.message}`);
    });
  }

  return results;
}

module.exports = { clampNumber, safeGetNumberSetting, safeGetNumberSettings };
