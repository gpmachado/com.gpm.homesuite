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

## Expanding support

The drivers are built around Zigbee cluster characteristics, not just model IDs.
If you have a device with similar clusters but a different manufacturerName,
it can likely be added with minimal changes to `driver.compose.json`.

Pull requests and tested additions are welcome.

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
