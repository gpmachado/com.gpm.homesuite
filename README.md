# HomeSuite — `com.gpm.homesuite`

A personal, unofficial Homey Pro app for a specific set of Zigbee devices —
**Tuya / Zemismart / NovaDigital** switches and plugs, plus **Sonoff / eWeLink**
relays and sensors. Every driver is validated on **real hardware**, not copied
from a spec sheet.

> **Status:** personal & experimental — **not** on the Homey App Store. It lives
> on GitHub and is installed from source. Licensed **GPL-3.0**.

---

## Origin

I started using Homey about two years ago and had a hard time finding working
drivers for my devices. I began from [Johan Bendz's `com.tuya.zigbee`](https://github.com/JohanBendz/com.tuya.zigbee)
as a reference base. My switches are **Zemismart / NovaDigital (white-label) TB26** —
only the 4- and 6-gang were supported there, and the rest used different
manufacturer IDs. I asked for them to be added, but the app wasn't being
updated. Zemismart later published an official app — but it doesn't work with my
units either.

So I kept what worked, rebuilt what didn't, and turned it into an app for my own
use. It was never published. Over time I kept improving it and adding features.

## How it's built

Evidence-driven, not spec-driven. To get each device right I:

- **Captured real traffic** with a CC2531 USB dongle (zboss sniffer firmware) +
  Wireshark, on both the **Tuya** and **Sonoff** networks, and decoded the frames
  (with help from Claude Code).
- **Cross-referenced** Hubitat (I came from there and keep a C8), **ZHA**, and
  **zigbee2mqtt** to validate cluster/attribute meanings.
- **Paired real devices** and debugged cluster reports, attribute types and
  reconnect behaviour until things actually worked.

When a community fork claimed support but wasn't based on real testing, much of
it didn't work for me — so the rule here is: if it's in the app, it was tested on
a device I own.

## License & credits

Licensed under the **GNU GPL v3.0** (see `LICENSE`). The app incorporates GPL-3.0
code ([StyraHem](https://github.com/StyraHem/Homey.Sonoff.Zigbee) /
[s-dimaio](https://github.com/s-dimaio/Homey.Sonoff.Zigbee), Homey.Sonoff.Zigbee)
alongside MIT-licensed portions ([Johan Bendz](https://github.com/JohanBendz/com.tuya.zigbee)),
which are GPL-compatible; the combined work is distributed under GPL-3.0. Full
attributions are in the `NOTICE` file.

---

## Core features

These cut across most drivers:

- **Availability tracking** — a custom library detects when a device goes silent
  vs. genuinely off the network. Mains/router devices are flagged unavailable when
  they exceed ~2× their average communication interval (tuned per type in
  `lib/constants.js`); inbound frames on the **Basic cluster (0)** act as a passive
  heartbeat. End devices use a longer window (less battle-tested, since mine rarely
  drop). Flow cards expose availability on/off.
- **Reconnect-after-power-cut detection** — a `device_rejoined` flow trigger that
  fires when a device comes back from a power cut, **independent of the
  availability window** (so a 10-minute outage still triggers even if the offline
  window is longer). See [Flow triggers](#flow-triggers).
- **Connected-devices info** — for multi-gang devices that pair as separate Homey
  sub-devices, a read-only field shows the whole group and which one is the **main
  (EP1)**. Settings that physically live only on EP1 are coordinated from there.
- **Settings surfaced as labels** — current values (power-on state, switch mode,
  etc.) are shown as read-only labels so you don't have to open the settings page
  to check them.
- **Smart-plug polling with exponential backoff** — stops hammering a plug that was
  unplugged and resumes when it returns.
- **Switch modes** — toggle / momentary (state) per device (1–3 gang).
- **Inching** (auto-off after a delay, per gang) — reverse-engineered from sniffer
  captures; persists across power cuts.
- **Power-on behaviour** — global and per-gang.
- **LED / backlight** — persistent and re-enforced after a power cut (the device
  resets it on restore; the app restores your preference).
- **No dead settings** — where Tuya firmware advertises a feature the actual hardware
  doesn't have (a tamper on a plug-in gas detector, an LED on a relay module), it's
  hidden rather than shown as a non-functional option.

## Flow triggers

### `device_rejoined` — fires on power restore

Mains-powered switches signal when they come **back**, not when they leave — a
1-second outage looks identical to a 5-minute one from the network's perspective.
`device_rejoined` fires as soon as the device reconnects, independently of
availability tracking, enabling flows like "breaker came back → turn the load on".

Supported on all mains-powered switches/relays (NovaDigital 1–6 gang, 1CH relay,
MOES 3-gang dimmer, smart plug, socket power strip, Sonoff ZBMINIR2, BASICZBR3).
Detection keys on the device's **boot dump** (the burst of config attributes /
datapoints a device re-reports only after rebooting), with guards against the
initial app-start dump and duplicate bursts. Routing-only rejoins and periodic
single-attribute reports do not trigger it.

### `ZBMINIR2:click`

Fires when the physical switch wired to a ZBMINIR2 is pressed, in Detach-Relay mode.

---

## Device notes

**Switches (Zemismart / NovaDigital TB26, 1–6 gang + 1CH relay)**
Johan's app only covered 4/6-gang; 1/2/3-gang and the inline 1CH relay are built
here. The 4/6-gang are EF00 datapoint devices (TS0601); the rest are ZCL (TS000x)
using the Tuya `0xE000` / `0xE001` private clusters. Each gang pairs as its own
sub-device; the main device's **Advanced Settings** expose:
- **Connected Switches** — the group and which one is the Main.
- **LED Backlight** and **LED Indicator** — persistent (re-enforced after a power cut).
- **Switch Mode** — Toggle (Standard) / Momentary — with a read-only *Current Mode* label.
- **Power-On Behavior** — global (all gangs) and per-gang, each with a *current* label.
- **Inching (auto-off)** with a delay in seconds, per gang.
- **Energy** — Always On + power usage (W) when off / on.

On the **1CH relay module**, the firmware also advertises an LED Backlight / LED
Indicator, but they have no effect on that hardware — so they're hidden rather than
shown as dead options (the backlight report is still observed as a power-restore signal).

**Smart plugs (TS011F, metering)**
Some weren't recognised by Homey at all; others worked via the Nous/Zemismart apps
but with no availability — so an unplugged plug went unnoticed. Here they report
metering, stop polling on no-response (backoff), and report availability.

**MOES 3-gang dimmer (used as a fan)**
In my setup this drives a fan, so there's a configurable **motor debounce** in the
advanced settings to protect the electric motor.

**Siren**
Used another app as reference. Battery level is detected. The siren has a USB
backup supply, but the USB↔battery source switch isn't reported by the firmware —
not even on the Tuya platform.

**Temperature / humidity sensors (Tuya, LCD)**
Two LCD models, one with a clock that the app sets — keeping the clock synced
reduces battery drain.

**Socket power strip (4 outlets + USB)**
Each outlet pairs as its own Homey sub-device under one physical node. The main
device's **Advanced Settings** expose:
- **Connected Sockets** — the whole group and which one is the Main, e.g.
  *"TV Samsung (Main) · AppleTV · Net Sw · Nintendo Switch · USB"* — so you can
  tell at a glance which Homey devices belong to the same physical strip.
- **Power-On (all sockets)** + a read-only *Current Power-On* label.
- **Physical controls** — LED indicator (e.g. *On when powered*) and child lock.
- **Energy** — *Always On* plus configurable power usage (W) when off / on.

**Gas detector (HEIMAN combustible gas — natural gas & LPG)**
A plug-in IAS-zone detector (pairs as `_TYZB01_0w3d5uw3` / TS0204). IAS-zone pairing
and availability. The firmware advertises a tamper, but the sensor is built into a
plug that doesn't open — there's no physical tamper — so the phantom setting is hidden.

**MOES wireless remotes (4-gang & 2-gang)**
Battery, single / double / long press. Long-press is only recognised when you hold
until the LED turns off — it works, but it's fiddly because the firmware sometimes
sends a single press instead of a long one.

**Tuya Zigbee repeater**
Devices that drop off (e.g. unplugged) past the configured tolerance are marked
unavailable, and recover automatically if they never actually left the network.

### Sonoff / eWeLink

Bundled into this app to centralise maintenance (different platform, but easily
separable into its own app).

- **ZBMINIR2** — the StyraHem app typed it as a *light* rather than a *socket*
  (until v1.13), and **turbo mode has been broken since it was added in v1.7.8**
  (still broken in the 1.13 test build). Here it's a switch with working turbo mode
  and availability.
- **BASICZBR3** — only existed in Johan's driver; a low-feature firmware. Added
  here mainly to give it availability.
- **SNZB-02LD / SNZB-02WD** — temp/humidity sensors, centralised into one app with
  availability. **Poll Control (`0x0020`) is intentionally not used** — it gives no
  benefit on these (zigbee2mqtt unbinds it on Sonoff because it slows polling).
- **Sonoff Zigbee USB Dongle** — a spare from Home Assistant testing, flashed with
  router firmware and given a repeater-style driver.

---

## Supported devices

| Device | Product ID | Manufacturer ID(s) |
|--------|------------|--------------------|
| NovaDigital / Zemismart switch 1 gang | TS0001 | `_TZ3000_ovyaisip` `_TZ3000_pk8tgtdb` |
| NovaDigital / Zemismart switch 2 gang | TS0002 | `_TZ3000_ywubfuvt` `_TZ3000_kgxej1dv` |
| NovaDigital / Zemismart switch 3 gang | TS0003 | `_TZ3000_yervjnlj` `_TZ3000_vjhcenzo` `_TZ3000_qxcnwv26` `_TZ3000_eqsair32` `_TZ3000_f09j9qjb` `_TZ3000_fawk5xjv` `_TZ3000_ok0ggpk7` |
| NovaDigital / Zemismart switch 4 gang | TS0601 | `_TZE200_shkxsgis` `_TZE204_aagrxlbd` |
| NovaDigital / Zemismart switch 6 gang | TS0601 | `_TZE200_r731zlxk` |
| 1-channel relay module (GIRIER) | TS0001 | `_TZ3000_tqlv4ug4` |
| MOES dimmer 3 gang | TS0601 | `_TZE204_1v1dxkck` |
| MOES 4-gang wireless remote | TS0044 | `_TZ3000_wkai4ga5` |
| 2-gang wireless remote | TS0042 | `_TZ3000_tzvbimpq` |
| Smart plug (metering) | TS011F | `_TZ3000_88iqnhvd` `_TZ3000_okaz9tjs` `_TZ3210_cehuw1lw` `_TZ3210_fgwhjm9j` |
| Socket power strip (4 + USB) | TS011F | `_TZ3000_cfnprab5` |
| LCD temperature & humidity sensor | TS0201 | `_TZ3000_ywagc4rj` |
| Temperature & humidity sensor w/ clock | TS0601 | `_TZE200_cirvgep4` `_TZE204_cirvgep4` |
| HEIMAN combustible gas detector (natural gas & LPG) | TS0204 | `_TYZB01_0w3d5uw3` |
| Siren | TS0601 | `_TZE204_q76rtoa9` |
| Zigbee repeater | TS0207 | `_TZ3000_nkkl7uzv` |
| Sonoff BASICZBR3 relay | BASICZBR3 | `SONOFF` |
| Sonoff ZBMINIR2 relay | ZBMINIR2 | `SONOFF` |
| Sonoff SNZB-02LD temp/humidity (LCD) | SNZB-02LD | `SONOFF` |
| Sonoff SNZB-02WD temp/humidity (display) | SNZB-02WD | `SONOFF` |
| Sonoff SNZB-03 motion sensor | MS01 | `eWeLink` |
| Sonoff Zigbee USB Dongle (router firmware) | DONGLE-E_R | `SONOFF` |

---

## Contributing

The code is on GitHub, but I only own a limited set of devices, so coverage is
limited to what I can physically test. If you have similar hardware and want it to
work better on Homey, help is very welcome — to **use it**, improve it, or expand
the list of supported devices:

- Share a **device interview** (Homey Developer Tools) and, ideally, a **Zigbee
  sniffer capture (`.pcapng`)** of the feature you want supported.
- **Test** the app on your devices and report back.
- Open issues / PRs.

Unofficial & experimental — install at your own risk.
