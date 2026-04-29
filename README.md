# HomeSuite — com.gpm.homesuite

A curated Homey app for a specific set of Zigbee devices, built from real-world need.

## Origin

This app started from [Johan Bendz's com.tuya.zigbee](https://github.com/JohanBendz/com.tuya.zigbee),
which served as a reference base. The problem: my devices weren't there, and adding them
required manually editing driver.compose files and compiling test builds just to try anything.

So I stripped it down — removed everything I didn't have, didn't need, and couldn't test —
and rebuilt the drivers through hands-on investigation: pairing devices, reading cluster
reports, debugging attribute behaviour, and fixing what didn't work.

## What was built and fixed

- Correct unavailability reporting (device silent vs. device gone from network)
- Backlight stays off after power restore if configured that way
- State and configuration sync on re-energisation (1, 2, 3 gang)
- Exponential backoff on smart plugs to avoid polling after unplug
- Sonoff ZBMiniR2 typed as switch (not light), with turbo mode support
- Battery reporting for sirens and temperature sensors
- Multi-gang: each outlet reports its own state and connected device info

## Flow triggers

### `device_rejoined` — fires on power restore

Mains-powered switches communicate when they come back, not when they leave.
A 1-second outage looks identical to a 5-minute one from the network's perspective.
The `device_rejoined` trigger fires as soon as the device reconnects — independently
of availability tracking — allowing flows like "breaker came back → turn on the load".

Supported on all mains-powered switches and relays (NovaDigital 1–6 gang,
MOES 3-gang dimmer, smart plug, socket power strip, Sonoff ZBMINIR2, BASICZBR3).

Detection mechanism per device family:

| Family | Signal |
|--------|--------|
| NovaDigital 1/2/3-gang | `tuyaE000` cluster `inchingTime` (0xD001) — sent by Tuya firmware on every reconnect |
| NovaDigital 4/6-gang | Tuya DP burst — 3+ DPs in < 600 ms |
| MOES 3-gang dimmer | Tuya `POWER_ON` DP (DP 14) |
| Smart plug / socket power strip | `tuyaE000` cluster `inchingTime` (0xD001) — sent by Tuya firmware on every reconnect |
| Sonoff ZBMINIR2 / BASICZBR3 | SonoffCluster `reportAttributes` (node-level frame hook) |

Note: `powerOnStateGlobal` (ZCL onOff attr 0x8001) was previously used as the rejoin signal
for 1/2/3-gang and smartplug devices but proved unreliable — Tuya TS011F/TS0003 firmware
sends it periodically (every 48–93 min), causing false `device_rejoined` triggers with no
actual power event. `inchingTime` is only sent on reconnect.

Guards: 120 s boot delay (ignores the initial attribute dump on app start),
30 s cooldown between consecutive rejoin signals from the same device.

### `ZBMINIR2:device_rejoined`

Driver-specific variant of the above for the ZBMINIR2.
Appears directly in the device's flow card list — no capability filter needed.
Fires simultaneously with the global `device_rejoined` card.

### `ZBMINIR2:click`

Fires when the physical switch connected to the ZBMINIR2 is pressed,
when the device is in Detach Relay mode.

## Supported devices

| Device | Product ID | Manufacturer ID |
|--------|------------|-----------------|
| NovaDigital / Zemismart switch 1 gang | TS0001 | `_TZ3000_ovyaisip` `_TZ3000_pk8tgtdb` |
| NovaDigital / Zemismart switch 2 gang | TS0002 | `_TZ3000_ywubfuvt` `_TZ3000_kgxej1dv` |
| NovaDigital / Zemismart switch 3 gang | TS0003 | `_TZ3000_yervjnlj` `_TZ3000_vjhcenzo` `_TZ3000_qxcnwv26` `_TZ3000_eqsair32` `_TZ3000_f09j9qjb` `_TZ3000_fawk5xjv` `_TZ3000_ok0ggpk7` |
| NovaDigital / Zemismart switch 4 gang | TS0601 | `_TZE200_shkxsgis` `_TZE204_aagrxlbd` |
| NovaDigital / Zemismart switch 6 gang | TS0601 | `_TZE200_r731zlxk` |
| Moes dimmer 3 gang | TS0601 | `_TZE204_1v1dxkck` |
| Smart plug | TS011F | `_TZ3000_88iqnhvd` `_TZ3000_okaz9tjs` `_TZ3210_cehuw1lw` `_TZ3210_fgwhjm9j` |
| Socket power strip | TS011F | `_TZ3000_cfnprab5` |
| LCD temperature & humidity sensor | TS0201 | `_TZ3000_ywagc4rj` |
| Temperature & humidity clock | TS0601 | `_TZE200_cirvgep4` `_TZE204_cirvgep4` |
| Gas detector | TS0204 | `_TYZB01_0w3d5uw3` |
| Siren | TS0601 | `_TZE204_q76rtoa9` |
| Zigbee repeater | TS0207 | `_TZ3000_nkkl7uzv` |
| Sonoff BASICZBR3 relay | BASICZBR3 | `SONOFF` |
| Sonoff ZBMINIR2 relay | ZBMINIR2 | `SONOFF` |
| Sonoff SNZB-02 temp/humidity sensor (LCD) | SNZB-02LD | `SONOFF` |
| Sonoff SNZB-02 temp/humidity sensor (display) | SNZB-02WD | `SONOFF` |
| Sonoff SNZB-03 motion sensor | MS01 | `eWeLink` |
| Sonoff Zigbee USB Dongle (router firmware) | DONGLE-E_R | `SONOFF` |
