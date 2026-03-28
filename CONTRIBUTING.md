# Contributing — Adding a New Device

This guide walks you through adding support for a device whose clusters are compatible
with existing drivers but has a different `manufacturerName`.

---

## 1. Get the device interview

1. Pair the device in Homey normally
2. Open [tools.developer.homey.app](https://tools.developer.homey.app) in your browser
3. Go to **Zigbee** → select your device → click **Interview**
4. Copy or download the resulting JSON

This gives you the device's endpoints and cluster IDs.

The `Homey_Interview/` folder in this repo contains examples for every supported device.
Use them as reference.

A typical interview output looks like this:

```json
{
  "ids": {
    "modelId": "TS0003",
    "manufacturerName": "_TZ3000_eqsair32"
  },
  "endpoints": {
    "endpointDescriptors": [
      {
        "endpointId": 1,
        "inputClusters": [0, 3, 4, 5, 6, 10, 57344, 57345],
        "outputClusters": [10, 25]
      },
      {
        "endpointId": 2,
        "inputClusters": [4, 5, 6, 57345]
      }
    ]
  }
}
```

---

## 2. Compare clusters with the driver.compose.json

Open the `driver.compose.json` of the most similar existing driver and compare
the `endpoints.clusters` arrays with the interview data.

**Common cluster IDs:**

| ID    | Name             | Purpose |
|-------|------------------|---------|
| 0     | Basic            | Device info, manufacturer, model |
| 3     | Identify         | Blink/identify |
| 4     | Groups           | Zigbee group membership |
| 5     | Scenes           | Scene recall |
| 6     | On/Off           | Switch control, backlight, powerOnState |
| 10    | Time             | Clock sync (silenced in this app) |
| 57344 | tuyaE000         | Tuya-specific (inching/pulse) |
| 57345 | tuyaPowerOnState | Per-gang power-on behaviour, switch mode |

If the clusters match the existing driver, only the `manufacturerName` needs to be added.
Open the driver's `driver.compose.json` and append the new value to the array:

```json
"manufacturerName": [
  "_TZ3000_yervjnlj",
  "_TZ3000_newdevice"
]
```

If the cluster layout is different (different endpoints, missing clusters), a new driver
may be needed — open an issue first to discuss.

---

## 3. Install dependencies

```bash
cd com.gpm.homesuite
npm install
```

---

## 4. Run the app on your Homey

```bash
homey app run --remote
```

This installs and runs the app directly on your Homey over the network.
Keep the terminal open — logs stream in real time.

---

## 5. Pair the device and analyse the log

Pair the new device through Homey. Watch the terminal for the init sequence.

**What to look for:**

```
[Main (Gang 1)] init -- My Switch ep:1 firstInit:true
[EP1] read switchMode: toggle
[EP1] read powerOnStateGang: lastState
[EP2] read powerOnStateGang: lastState
```

**Red flags:**

- `Could not reach device` during init → mesh/timing issue, retry pairing
- `already registered` warning on capability → duplicate listener registration
- `readAttributes failed` on first init → non-critical, device will report on rejoin
- Silent init (no logs at all) → `manufacturerName` not matched in `driver.compose.json`

---

## 6. Test the device

Run through this checklist before submitting a pull request.

### On/Off

- [ ] Toggle the switch in Homey UI → correct gang turns on/off physically
- [ ] Press physical button → Homey UI updates correctly
- [ ] No other gang changes state (no crosslink)

### Multi-gang (if applicable)

- [ ] Each gang controls only its own endpoint
- [ ] Renaming one gang updates the sibling info on all gangs

### Power restore

- [ ] Cut and restore power to the device
- [ ] All gang states are restored correctly in Homey
- [ ] Backlight behaviour matches the setting (on/off)

### Settings

- [ ] **Backlight**: toggle off → device backlight turns off; restore power → stays off
- [ ] **Power-on behaviour (per gang)**: set to Always Off / Always On / Last State → restore power → device respects setting
- [ ] **Switch mode**: toggle Momentary ↔ Standard → physical button behaves accordingly

### Availability

- [ ] Unplug device → after timeout Homey marks it unavailable
- [ ] Replug device → Homey marks it available again

---

## 7. Save the interview file

Save the raw interview JSON to `Homey_Interview/<category>/` using the naming convention:

```
3G_TZ3000_newdevice.txt
```

This helps future contributors verify cluster compatibility without pairing the device.

---

## 8. Submit the pull request

- One device (or one manufacturer variant) per PR
- Include the interview file
- Describe what was tested and on which hardware
- If behaviour differs from existing devices, document it in the PR description
