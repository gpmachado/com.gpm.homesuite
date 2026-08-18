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
- **Staggered timing (jitter)** — reporting intervals, startup polling and retry
  backoff carry a small random offset, so devices don't all report/poll at the same
  instant (avoids mesh congestion / a "thundering herd" hitting the hub at once).
- **Switch modes** — toggle / momentary (state) per device (1–3 gang).
- **Inching** (auto-off after a delay, per gang) — reverse-engineered from sniffer
  captures; persists across power cuts.
- **Power-on behaviour** — global and per-gang.
- **LED / backlight** — persistent and re-enforced after a power cut (the device
  resets it on restore; the app restores your preference).
- **No dead settings** — where Tuya firmware advertises a feature the actual hardware
  doesn't have (a tamper on a plug-in gas detector, an LED on a relay module), it's
  hidden rather than shown as a non-functional option.
- **Rejoin history** — a dedicated tab in the app's Settings page lists, per device,
  how many power-restore rejoins were detected and when the last one happened, with
  a global reset. Complements the existing Zigbee Traffic tab (message counts per
  hour/24h) without mixing the two differently-paced datasets in one table.
- **Backlight flow cards** — a `Set backlight` action and `Backlight is on` condition
  for NovaDigital switches with an LED backlight, so you can query or force the LED
  state from a flow (the condition does a live read from the device rather than
  trusting the last-known setting). On multi-gang boards the backlight is physically
  a single EP1-level LED, so the device picker only offers the **Main** device.

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
Johan's app only covered 4/6-gang; 1/2/3-gang (+ touch) and the inline 1CH
relay are built here. The 1/2/3-gang (+ touch) are ZCL (TS000x) using the
Tuya `0xE000` / `0xE001` private clusters; the 4/6-gang are EF00 datapoint
devices (TS0601) on **different, more limited firmware** — don't assume
feature parity across the family. Each gang pairs as its own sub-device.

*1/2/3-gang (+ touch) / 1CH relay* — main device's **Advanced Settings** expose:
- **Connected Switches** — the group and which one is the Main.
- **LED Backlight** and **LED Indicator** — persistent (re-enforced after a power cut).
- **Switch Mode** — Toggle (Standard) / Momentary — with a read-only *Current Mode* label.
- **Power-On Behavior** — global (all gangs) and per-gang, each with a *current* label.
- **Inching (auto-off)** with a delay in seconds, per gang.
- **Energy** — Always On + power usage (W) when off / on.

*4-gang* — firmware exposes only **Connected Switches** and a *global*
**Power-On Behavior** (with a current-value label) — no backlight, no LED
indicator, no switch mode, no inching, no per-gang power-on.

*6-gang* — even more limited: only **Connected Switches**. No power-on
behavior setting at all (not even global), and none of the 4-gang's other
settings either.

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

**Aqara FP1 / RTCZCGQ11LM**
The FP1 uses Aqara's proprietary `manuSpecificLumi` cluster instead of the normal
temperature / occupancy clusters, so the driver maps the device the same way
Zigbee2MQTT does:
- `presence` -> `alarm_occupancy`
- `device_temperature` -> `measure_temperature`
- `power_outage_count` -> optional read-only capability, hidden by default
- `presence_event` -> Flow trigger for `enter`, `leave`, `approach`, `away`, etc.
- `monitoring_mode`, `approach_distance`, `motion_sensitivity` -> device settings
- `reset_nopresence_status` -> action card that resets no-presence state

The sensor also reports a packed `0x00F7` lifeline struct with temperature and
power-outage count. That struct is parsed directly from the raw report payload.

**MOES wireless remotes (4-gang & 2-gang)**
Battery, single / double / long press. Long-press is only recognised when you hold
until the LED turns off — it works, but it's fiddly because the firmware sometimes
sends a single press instead of a long one.

**Tuya Zigbee repeater**
Devices that drop off (e.g. unplugged) past the configured tolerance are marked
unavailable, and recover automatically if they never actually left the network.

**1/2/3-channel relay modules (GIRIER and other TS0001/2/3 variants)**
Same family as the NovaDigital switches but sold under different manufacturer IDs;
each channel count gets its own driver so wiring/pairing matches the physical board.

**Door & window sensors (TS0203, two manufacturer variants)**
IAS-zone contact sensors; a second driver (`doorwindowsensor_2`) covers a variant
that reports slightly differently and wasn't reliably matched by the first.

**Radar sensor (Linptech / Moes TS0225, mmWave presence)**
Very chatty on the mesh by firmware design — `configureReporting` is rejected by
the device (`UNSUP_CLUSTER_COMMAND`, confirmed on real hardware and matching
zigbee-herdsman-converters' own Linptech definition, which never attempts it
either), so the report rate can't be throttled from the app side.

**Ultrasonic liquid level sensor (water tank)**
Tank level/percentage plus high/low alarms from a Tuya EF00 ultrasonic sensor.

**Wireless remotes (2-gang TS0042, 4-gang MOES TS0044)**
Battery-powered scene controllers; press events exposed as flow triggers.

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
- **SNZB-06P** — 24 GHz presence sensor with availability.
- **MINI-ZB1GP** — single-channel relay with energy metering (power, current,
  voltage, accumulated consumption). `resetConsumption` was identified by
  reverse-engineering a real sniffer capture (it's not in any public reference) and
  confirmed working against real hardware — exposed as a flow action to zero the
  accumulated meter.
- **MINI-ZBD** — the dry-contact ("MINI Dry") sibling of the ZBMINIR2: same
  protocol and settings, but the output is an isolated dry contact for triggering
  external equipment (gate, garage door) rather than switching a mains load, so it's
  named and paired accordingly.

---

## Supported devices

EP1 cluster IDs (decimal) as declared in each driver's `driver.compose.json` —
not necessarily the device's full raw cluster list. See
[Note on cluster IDs](#note-on-cluster-ids) below to decode them.

| Device | Product ID | Manufacturer ID(s) | Clusters (EP1) |
|--------|------------|--------------------|-----------------|
| NovaDigital / Zemismart switch 1 gang | TS0001 | `_TZ3000_ovyaisip` `_TZ3000_pk8tgtdb` | 0, 3, 4, 5, 6, 10, 57344, 57345 |
| NovaDigital / Zemismart switch 2 gang | TS0002 | `_TZ3000_ywubfuvt` `_TZ3000_kgxej1dv` | 0, 3, 4, 5, 6, 10, 57344, 57345 |
| NovaDigital / Zemismart switch 2 gang (touch) | TS0002 | `_TZ3000_jjdkhueq` | 0, 3, 4, 5, 6, 10, 57344, 57345 |
| NovaDigital / Zemismart switch 3 gang | TS0003 | `_TZ3000_yervjnlj` `_TZ3000_vjhcenzo` `_TZ3000_qxcnwv26` `_TZ3000_eqsair32` `_TZ3000_f09j9qjb` `_TZ3000_fawk5xjv` `_TZ3000_ok0ggpk7` | 0, 3, 4, 5, 6, 10, 57344, 57345 |
| NovaDigital / Zemismart switch 4 gang | TS0601 | `_TZE200_shkxsgis` `_TZE284_shkxsgis` `_TZE204_aagrxlbd` | 0, 4, 5, 10, 61184 |
| NovaDigital / Zemismart switch 4 gang (ZCL) | TS0004 | `_TZ3000_lwthnp7j` | 0, 3, 4, 5, 6, 57344, 57345 |
| NovaDigital / Zemismart switch 6 gang | TS0601 | `_TZE200_r731zlxk` `_TZE284_r731zlxk` | 0, 4, 5, 10, 61184 |
| 1-channel relay module (GIRIER + variants) | TS0001 | `_TZ3000_npzfdcof` `_TZ3000_hktqahrq` `_TZ3000_mx3vgyea` `_TZ3000_5ng23zjs` `_TZ3000_rmjr4ufz` `_TZ3000_v7gnj3ad` `_TZ3000_qsp2pwtf` `_TZ3000_oex7egmt` `_TZ3000_tqlv4ug4` | 0, 3, 4, 5, 6, 57344, 57345 |
| 2-channel relay module | TS0002 | `_TZ3000_fisb3ajo` `_TZ3000_bvrlqyj7` `_TZ3000_7ed9cqgi` `_TZ3000_lmlsduws` `_TZ3000_qaa59zqd` `_TZ3000_ruxexjfz` `_TZ3000_zmy4lslw` `_TZ3000_hznzbl0x` `_TZ3000_mtnpt6ws` `_TZ3000_pxfjrzyj` | 0, 3, 4, 5, 6, 57344, 57345 |
| 3-channel relay module | TS0003 | `_TZ3000_odzoiovu` `_TZ3000_lvhy15ix` `_TZ3000_4o16jdca` | 0, 3, 4, 5, 6, 57344, 57345 |
| MOES dimmer 3 gang | TS0601 | `_TZE204_1v1dxkck` | 0, 4, 5, 61184 |
| MOES 4-gang wireless remote | TS0044 | `_TZ3000_wkai4ga5` | 0, 1, 6 |
| 2-gang wireless remote | TS0042 | `_TZ3000_tzvbimpq` | 0, 1, 6 |
| Smart plug (metering) | TS011F | `_TZ3000_88iqnhvd` `_TZ3000_okaz9tjs` | 0, 3, 4, 5, 6, 10, 1794, 2820, 57344, 57345 |
| Smart plug (metering, `_TZ3210` variant) | TS011F | `_TZ3210_fgwhjm9j` | 0, 3, 4, 5, 6, 10, 1794, 2820, 57344, 57345 |
| Smart plug (metering, `_TZ3000_cehuw1lw` variant) | TS011F | `_TZ3000_cehuw1lw` | 0, 3, 4, 5, 6, 10, 1794, 2820, 4096, 6280, 57344 |
| Socket power strip (4 + USB) | TS011F | `_TZ3000_cfnprab5` | 0, 3, 4, 5, 6, 57344 |
| LCD temperature & humidity sensor | TS0201 | `_TZ3000_ywagc4rj` | 0, 1, 3, 1026, 1029 |
| Temperature & humidity sensor w/ clock | TS0601 | `_TZE200_cirvgep4` `_TZE204_cirvgep4` | 0, 4, 5, 61184 |
| HEIMAN combustible gas detector (natural gas & LPG) | TS0204 | `_TYZB01_0w3d5uw3` | 0, 3, 1280, 2821 |
| Siren | TS0601 | `_TZE204_q76rtoa9` | 0, 4, 5, 61184 |
| Door & window sensor | TS0203 | `_TZ3000_7tbsruql` `_TZ3000_osu834un` | 0, 1, 3, 1280 |
| Door & window sensor (variant 2) | TS0203 | `_TZ3000_6zvw8ham` | 0, 1, 3, 1280 |
| Radar sensor (Linptech / Moes, mmWave presence) | TS0225 | `_TZ3218_t9ynfz4x` `_TZ3218_awarhusb` | 0, 3, 4, 5, 1024, 1280, 16384, 57346, 61184 |
| Ultrasonic liquid level sensor (water tank) | TS0601 | `_TZE200_lvkk0hdg` | 0, 4, 5, 61184 |
| Zigbee repeater | TS0207 | `_TZ3000_nkkl7uzv` | 0, 3, 10 |
| Sonoff BASICZBR3 relay | BASICZBR3 | `SONOFF` | 0, 3, 4, 5, 6 |
| Sonoff ZBMINIR2 relay | ZBMINIR2 | `SONOFF` | 0, 3, 4, 6, 2821, 64529, 64599 |
| Sonoff MINI-ZBD dry contact | MINI-ZBD | `SONOFF` | 0, 3, 4, 6, 2821, 64529, 64599 |
| Sonoff MINI-ZB1GP energy meter | MINI-ZB1GP | `SONOFF` | 0, 3, 4, 5, 6, 1794, 2820, 64529, 64599 |
| Sonoff SNZB-02LD temp/humidity (LCD) | SNZB-02LD | `SONOFF` | 0, 1, 1026, 64529 |
| Sonoff SNZB-02WD temp/humidity (display) | SNZB-02WD | `SONOFF` | 0, 1, 1026, 1029, 64529 |
| Sonoff SNZB-03 motion sensor | MS01 | `eWeLink` | 0, 1, 1280 |
| Sonoff SNZB-06P presence sensor (24 GHz) | SNZB-06P | `SONOFF` | 0, 3, 1030, 1280, 64529 |
| Aqara FP1 presence sensor | `lumi.motion.ac01` | `aqara` | 0, 3, 64704 |
| Sonoff Zigbee USB Dongle (router firmware) | DONGLE-E_R | `SONOFF` | 0, 3, 4, 5, 6, 4096 |

<a id="note-on-cluster-ids"></a>
**Note on cluster IDs:** standard ZCL — `0` Basic, `1` PowerConfiguration
(battery), `3` Identify, `4` Groups, `5` Scenes, `6` OnOff, `10` Time,
`1024` Illuminance, `1026` Temperature, `1029` Humidity, `1030` Occupancy,
`1280` IASZone, `1794` Metering, `2820` ElectricalMeasurement, `2821`
Diagnostics, `4096` Touchlink (commissioning). Manufacturer-specific —
`57344`/`57345` Tuya `0xE000`/`0xE001` private clusters; `61184` Tuya
`0xEF00` (devices on this cluster speak an internal datapoint/DP protocol
instead of standard ZCL attributes); `57346` the Linptech/Moes radar's
proprietary `0xE002` attribute set; `64529`/`64599` Sonoff/eWeLink
`0xFC11`/`0xFC57`; `64704` Aqara's TLV-encoded `0xFCC0`; `16384` (`0x4000`)
and `6280` (`0x1888`) are vendor-specific clusters seen on the radar sensor
and the `_TZ3000_cehuw1lw` smart plug respectively — not yet identified
beyond "the device declares them". See
[lib/clusterRegistry.js](#library-architecture) for where the custom ones
are defined.

---

## Library architecture

Shared code lives in `lib/`, organised by what it does rather than by which
driver uses it. Every Zigbee device driver extends one of the base classes
below instead of duplicating init/teardown/settings logic.

### Device base classes

- **`TuyaZclBase.js`** — base for standard ZCL (TS000x/TS011x) Tuya devices:
  sibling/multi-gang coordination, on/off + backlight + indicator + power-on
  listener wiring (with reinit-safe stable references), boot-burst rejoin
  detection, re-enforce-after-power-restore retries, Time cluster binding.
- **`TuyaSpecificClusterDevice.js`** — base for Tuya's `0xEF00` datapoint (DP)
  protocol devices (TS0601): DP encode/decode, heartbeat monitoring, time-sync
  response, exponential backoff with jitter.
- **`TuyaRelayMultiGangBase.js`** — shared logic for TS0002/TS0003 inline relay
  modules (no wall-switch controls, so backlight/switch-mode/indicator are
  deliberately omitted).
- **`NovaDigitalTuyaDpSwitchBase.js`** — base for the NovaDigital 4/6-gang
  (Tuya DP-protocol) switches: main/gang resolution, availability install
  (main device only), per-gang DP routing.
- **`SonoffBase.js`** — base for Sonoff/eWeLink devices: battery-report
  wiring, retrying attribute reads, filtered attribute writes, idempotent
  teardown.
- **`SmartPlugBase.js`** — the TS011F smart-plug driver: manual polling engine
  with exponential backoff, E001 boot-frame rejoin detection, metering/power
  parsing (including a V×A fallback for firmware that misreports power).
  `smartplug`/`smartplug_2`/`smartplug_3` are thin variant drivers on top of
  this, each tuning reporting intervals for their specific firmware's chatter.

### Custom Zigbee clusters

Registered once at app boot via **`clusterRegistry.js`** (calling
`Cluster.addCluster()` per-driver causes redundant re-registration).

- **`SonoffCluster.js`** — manufacturer-specific `0xFC11`: turbo mode, switch
  mode, power-on delay, inching, `resetConsumption` (sniffer-confirmed, not
  in any public reference).
- **`SonoffOnOffSwitchCluster.js`** — extends the standard OnOffSwitch cluster
  with Sonoff's `switchType`/`switchAction` attributes.
- **`TuyaBasicCluster.js`** — extends the standard Basic cluster (`0x0000`)
  with the manufacturer-specific attributes Tuya devices report unsolicited.
- **`TuyaSpecificCluster.js`** — the `0xEF00` DP-protocol cluster: datapoint
  encode/decode, reporting, time sync, heartbeat.
- **`TuyaE000Cluster.js`** / **`TuyaPowerOnStateCluster.js`** — Tuya's
  `0xE000`/`0xE001` private clusters (present on EP1 of most ZCL Tuya
  switches/plugs): inching, per-gang power-on-behaviour enums.
- **`ExtendedOnOffCluster.js`** — extends the standard OnOff cluster
  (`0x0006`) with backlight, indicator mode and global power-on-state — the
  type-strict enum8 attribute types matter here (devices silently ignore a
  write with the wrong ZCL type byte even though they ACK it).
- **`AqaraLumiCluster.js`** — Aqara's proprietary `0xFCC0`, TLV-encoded
  within manufacturer-specific ZCL frames (mfr code `0x115F`).
- **`ManuSpecificTuya3Cluster.js`** — the Linptech/Moes radar's proprietary
  `0xE002` attribute set (presence keep-time, sensitivity, LED, distance).
- **`TimeCluster.js`** — the standard Time cluster (`0x000A`) schema plus
  `TimeServerBoundCluster`: a real Time server responding with live
  UTC/timezone and a synchronized status, not a placeholder — see
  [core features](#core-features) and the cluster table's
  [note on cluster IDs](#note-on-cluster-ids). Also exports
  `BasicSilentBoundCluster` (absorbs unsolicited Basic-cluster frames — this
  one genuinely is a no-op) and `SonoffTimeServerBoundCluster` (adds DST
  attributes some Sonoff devices ask for).

### Frame / binding handling

- **`OnOffBoundCluster.js`** — `BoundCluster` for the standard OnOff cluster,
  handling physical-button commands devices send to the coordinator directly
  (not via attribute report).
- **`IASZoneHelper.js`** — shared IAS-zone enrollment (zone status parsing,
  CIE-address write, re-enrollment on factory reset) used by every IAS-zone
  sensor (motion, contact, gas).

### Cross-cutting infrastructure

- **`AvailabilityManager.js`** — the availability/rejoin/message-stats engine
  used by every driver: `AvailabilityManagerPassive` (passive `handleFrame`
  hook — any inbound frame counts as a heartbeat, used for mains devices) and
  `AvailabilityManagerCallback` (no automatic hook; the driver calls
  `_markAliveFromAvailability()` manually — used for battery/sleepy devices).
  Also owns hourly message-stat tracking (the Settings page's Zigbee Traffic
  tab) and rejoin-count persistence (the Rejoins tab).
- **`connectedDevices.js`** — utilities for multi-gang/multi-socket devices
  that pair as separate Homey sub-devices sharing one physical Zigbee node
  (sibling lookup, "Connected Switches" label sync).

### Utilities

- **`ZclOnOffSettings.js`** — normalizes vendor-inconsistent enum encodings
  (e.g. `powerOnStateGlobal` as uint8 `0/1/2` vs. a string) into consistent
  setting values/labels.
- **`errorUtils.js`** — classifies ZCL errors (reachability failure vs.
  attribute/feature error) so drivers can decide whether to retry, mark
  unavailable, or just log.
- **`settingsUtils.js`** — safely reads/clamps numeric settings against
  `[min, max]`, since Homey validates all settings together on every
  `setSettings()` call.
- **`constants.js`** — single source of truth for heartbeat timeout tiers
  (grouped by silence tolerance, not device brand), polling intervals, and
  the `ZCL_DEBUG` flag that switches on verbose `zigbee-clusters` frame
  logging + extra app-side diagnostics.

---

## Contributing

The code is on GitHub, but I only own a limited set of devices, so coverage is
limited to what I can physically test.

**Easy to extend to same-cluster devices.** Many Zigbee devices differ only by
manufacturer ID — if yours shares the same clusters as a supported one, adapting it
is often just **adding your manufacturer ID to the matching driver's
`driver.compose.json`** (no code change), or forking to customise further. The
GIRIER 1CH relay was added this way: it reuses the switch driver (TS0001 +
`0xE000`/`0xE001`) with its own manufacturer ID.

If you have similar hardware and want it to work better on Homey, help is very
welcome — to **use it**, improve it, fork it, or expand the device list:

- Share a **device interview** (Homey Developer Tools) and, ideally, a **Zigbee
  sniffer capture (`.pcapng`)** of the feature you want supported.
- **Test** the app on your devices and report back.
- Open issues / PRs.

Unofficial & experimental — install at your own risk.
