HomeSuite adds support for a curated set of Zigbee devices to your Homey, with a focus on reliable behavior and correct reporting.

Supported wall switches (NovaDigital & Zemismart, 1 to 6 gang) restore both their state and configuration after a power outage. The backlight can be set to remain off even when power is restored. Multi-gang models correctly report the status of each individual outlet. Devices that stop responding are shown as unavailable in Homey — even before they fully leave the Zigbee network.

Smart plugs use availability detection to avoid unnecessary polling after being unplugged. Temperature, humidity, and motion sensors report battery levels accurately. The siren also reports battery. Temperature sensors display the same value on screen as exported to Homey flows.

The Sonoff ZBMiniR2 and BASICZBR3 relays are included as switches (not lights), avoiding false lamp usage counters. The ZBMiniR2 also supports turbo mode. Two Sonoff temperature and humidity sensors (SNZB-02, SNZB-03) are bundled in the same app to keep things simple.

Supported devices:
- NovaDigital & Zemismart wall switches — 1, 2, 3, 4 and 6 gang
- Sonoff ZBMiniR2 and BASICZBR3 relays
- Sonoff SNZB-02 temperature/humidity sensor
- Sonoff SNZB-03 motion sensor
- Smart plugs and power strips
- Temperature & humidity clock
- Gas detector and siren
- Zigbee repeater
- Sonoff Zigbee USB Dongle (coordinator)
