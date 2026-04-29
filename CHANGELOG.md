# Changelog

## [1.0.8] - 2026-04-26

### Fixed
- **device_rejoined false positives** — Tuya TS011F firmware reports `powerOnStateGlobal` periodically (every 48–93 min), not only on power restore. This caused spurious `device_rejoined` flow triggers on the smartplug and 1/2/3-gang switches even without any actual power event. Detection for these devices is now based on `tuyaE000` cluster attr `inchingTime` (0xD001), which Tuya firmware only sends on reconnect/power restore — not periodically. Zero false positives confirmed in testing.
- **boot guard bypass on smartplug and socket_power_strip** — Both drivers override `_installAvailability()` without calling `super`, so `this._startedAt` was never set. The `_notifyRejoin()` 120 s startup delay guard evaluated `(Date.now() - 0) < 120 000` which is always false, allowing rejoin flows to fire immediately on app startup. Fixed by setting `this._startedAt = Date.now()` inside each override.
- **onEndDeviceAnnounce not reliable for short power cuts** — ZDO Device Announce (0x0013) is only sent when a device performs a full network rejoin. Short power interruptions (< ~10 s) on TS011F and TS0003 devices cause the device to resume silently without rejoining — `onEndDeviceAnnounce` never fires. `tuyaE000` inchingTime fires in both cases.

### Changed
- **`_suppressTuyaE000` → `_attachTuyaBootListener`** — The method now registers a real listener on `attr.inchingTime` that calls `_notifyRejoin()`, replacing the previous no-op suppression. `_suppressTuyaE000` kept as a deprecated alias. Called on: 1-gang, 2-gang, 3-gang, smartplug, socket_power_strip.

### Detection mechanism summary (updated)

| Family | Signal |
|--------|--------|
| NovaDigital 1/2/3-gang | `tuyaE000` `inchingTime` (0xD001) on reconnect |
| NovaDigital 4/6-gang | Tuya DP burst — 3+ DPs in < 600 ms |
| MOES 3-gang dimmer | Tuya `POWER_ON` DP (DP 14) |
| Smart plug / socket power strip | `tuyaE000` `inchingTime` (0xD001) on reconnect |
| Sonoff ZBMINIR2 / BASICZBR3 | SonoffCluster `reportAttributes` (node-level frame hook) |

## [1.0.7] - 2026-04-24

### Fixed
- **smartplug** — `onSettings` now uses `setGlobalPowerOnState`, `setIndicatorMode` and `setChildLock` from `ExtendedOnOffCluster` instead of generic `writeAttributes`, ensuring correct ZCL encoding for all three settings
- **smartplug** — `_parsePower` no longer reports spurious `0 W` when `calcPower=true` and the voltage/current cache is not yet populated while the device is on; returns `null` instead so the previous value is preserved in the UI
- **1-gang switch** — removed runtime `ReferenceError` caused by `powerOnSettingsPatch` being called without import on first pairing; replaced with `_readGangPowerOnState` helper, aligning with 2/3-gang pattern
- **socket_power_strip** — removed stale reference to `_bootPersistBacklight` in file header (method does not exist in `TuyaZclBase`)

### Improved
- **AvailabilityManager** — idle watchdog log (`Idle: Xmin`) is now opt-in (`logIdle: false` by default); only availability transitions (timeout, unavailable, restoring, available) are logged by default, reducing noise with many paired devices
- **TuyaZclBase** — `_configureOnOffReporting` applies ±10 % jitter to `maxInterval` via `applyJitter()`, staggering report schedules across devices to reduce simultaneous mesh traffic after a restart
- **TuyaZclBase** — centralised `_attachGangPowerOnListener`, `_readGangPowerOnState`, `_writeGangPowerOnState` and `_configureOnOffReporting` helpers; applied to 1/2/3-gang drivers (−96 lines across drivers)
- **TuyaZclBase** — unified base for 1/2/3-gang ZCL switches, smartplug and socket power strip (renamed from `NovaDigitalSwitchBase`)
- **NovaDigital 4/6-gang** — dedicated `NovaDigitalTuyaDpSwitchBase` for Tuya DP (EF00 cluster) switches

### Internal
- `ZclOnOffSettings.js` — added `normalizePowerOnState`, `getPowerOnLabel`, `indicatorSettingsPatch`, `applyJitter` helpers
- `connectedDevices.js` — removed dead code and circular import
- `AvailabilityManager` — early return in watchdog when device is already unavailable; I/O throttled to 60 s
- Flow double-fire fixed on 5 drivers
- `.homeyignore` corrected; `.DS_Store` removed from git

## [1.0.6] - 2026-04-01

- Initial stable release
