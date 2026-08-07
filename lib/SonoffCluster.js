const { Cluster, ZCLDataTypes } = require("zigbee-clusters");
const { DataType } = require('@athombv/data-types');

// BITMAP8 type (ZCL type ID 0x18) that serializes/deserializes as a plain number.
const bitmap8 = new DataType(
    0x18,
    'bitmap8',
    1,
    (buf, v, i) => buf.writeUInt8(typeof v === 'number' ? v & 0xFF : 0, i),
    (buf, i)    => buf.readUInt8(i)
);

const bitmap32 = new DataType(
    0x1B,
    'bitmap32',
    4,
    (buf, v, i) => buf.writeUInt32LE(typeof v === 'number' ? v : 0, i),
    (buf, i)    => buf.readUInt32LE(i)
);

class SonoffCluster extends Cluster {

    static get ID() {
        return 64529;
    }
    
    static get NAME() {
        return 'SonoffCluster';
    }
    
    static get ATTRIBUTES() {
        return {
            child_lock: {
                id: 0x0000,
                type: ZCLDataTypes.bool
            },
            fault_code: {
                id: 0x0010,
                type: ZCLDataTypes.int32
            },
            TurboMode: {
                id: 0x0012,
                type: ZCLDataTypes.int16
            },
            power_on_delay_state: {
                id: 0x0014,
                type: ZCLDataTypes.bool        
            },
            power_on_delay_time: {
                id: 0x0015,
                type: ZCLDataTypes.uint16
            },
            switch_mode: {
                id: 0x0016,
                type: ZCLDataTypes.uint8
            },
            detach_mode: {
                id: 0x0017,
                type: ZCLDataTypes.bool
            },
            deviceWorkMode: {
                id: 0x0018,
                type: ZCLDataTypes.uint8
            },
            detach_relay_mode2: {
                id: 0x0019,
                type: bitmap8
            },
            inching_control_bits: {
                id: 0x001C,
                type: bitmap32
            },
            temperatureCalibration: {
                id: 0x2003,
                type: ZCLDataTypes.int16
            },
            humidityCalibration: {
                id: 0x2004,
                type: ZCLDataTypes.int16
            },
            network_led: {
                id: 0x0001,
                type: ZCLDataTypes.bool
            },
            temperatureUnits: {
                id: 0x0007,
                type: ZCLDataTypes.uint16
            },
            backlight: {
                id: 0x0002,
                type: ZCLDataTypes.bool
            },
            tamper: {
                id: 0x2000,
                type: ZCLDataTypes.uint8
            },
            illuminance: {
                id: 0x2001,
                type: ZCLDataTypes.uint8
            },
            open_window: {
                id: 0x6000,
                type: ZCLDataTypes.bool
            },
            frost_protection_temperature: {
                id: 0x6002,
                type: ZCLDataTypes.int16
            },
            idle_steps: {
                id: 0x6003,
                type: ZCLDataTypes.uint16
            },
            closing_steps: {
                id: 0x6004,
                type: ZCLDataTypes.uint16
            },
            valve_opening_limit_voltage: {
                id: 0x6005,
                type: ZCLDataTypes.uint16
            },
            valve_closing_limit_voltage: {
                id: 0x6006,
                type: ZCLDataTypes.uint16
            },
            valve_motor_running_voltage: {
                id: 0x6007,
                type: ZCLDataTypes.uint16
            },
            valve_opening_degree: {
                id: 0x600b,
                type: ZCLDataTypes.uint8
            },
            valve_closing_degree: {
                id: 0x600c,
                type: ZCLDataTypes.uint8
            },
            protocolDataReport: {
                id: 0x0022,
                type: ZCLDataTypes.buffer
            },
            // MINI-ZB1GP / MINI-ZB1GSP energy meter attributes (from z2m)
            acCurrentCurrentValue: {
                id: 0x7004,
                type: ZCLDataTypes.uint32
            },
            acCurrentVoltageValue: {
                id: 0x7005,
                type: ZCLDataTypes.uint32
            },
            acCurrentPowerValue: {
                id: 0x7006,
                type: ZCLDataTypes.uint32
            },
            outlet_control_protect: {
                id: 0x7007,
                type: ZCLDataTypes.uint8
            },
            energyToday: {
                id: 0x7009,
                type: ZCLDataTypes.uint32
            },
            energyMonth: {
                id: 0x700A,
                type: ZCLDataTypes.uint32
            },
            energyYesterday: {
                id: 0x700B,
                type: ZCLDataTypes.uint32
            },
            outputEnergyToday: {
                id: 0x7018,
                type: ZCLDataTypes.uint32
            },
            outputEnergyMonth: {
                id: 0x7019,
                type: ZCLDataTypes.uint32
            },
            outputEnergyYesterday: {
                id: 0x701A,
                type: ZCLDataTypes.uint32
            },
            totalEnergyConsumption: {
                id: 0x701E,
                type: ZCLDataTypes.uint32
            },
            totalOutputEnergyConsumption: {
                id: 0x701F,
                type: ZCLDataTypes.uint32
            },
            daily_reverse_energy: {
                id: 0x7018,
                type: ZCLDataTypes.uint32
            },
            monthly_reverse_energy: {
                id: 0x7019,
                type: ZCLDataTypes.uint32
            },
            daily_run_time: {
                id: 0x701C,
                type: ZCLDataTypes.uint32
            },
            total_run_time: {
                id: 0x701D,
                type: ZCLDataTypes.uint32
            },
            total_forward_energy: {
                id: 0x701E,
                type: ZCLDataTypes.uint32
            },
            total_reverse_energy: {
                id: 0x701F,
                type: ZCLDataTypes.uint32
            },
            voltage_frequency: {
                id: 0x7029,
                type: ZCLDataTypes.uint32
            },
            // Additional attributes from z2m for various Sonoff devices
            setCalibrationAction: {
                id: 0x001D,
                type: ZCLDataTypes.charStr
            },
            calibrationStatus: {
                id: 0x001E,
                type: ZCLDataTypes.uint8
            },
            transitionTime: {
                id: 0x001F,
                type: ZCLDataTypes.uint32
            },
            calibrationProgress: {
                id: 0x0020,
                type: ZCLDataTypes.uint8
            },
            programmableStepperSequence: {
                id: 0x0022,
                type: ZCLDataTypes.buffer
            },
            minBrightnessThreshold: {
                id: 0x4001,
                type: ZCLDataTypes.uint8
            },
            maxBrightnessThreshold: {
                id: 0x4002,
                type: ZCLDataTypes.uint8
            },
            dimmingLightRate: {
                id: 0x4003,
                type: ZCLDataTypes.uint8
            },
            levelForCalibration: {
                id: 0x4006,
                type: ZCLDataTypes.uint8
            },
            lackWaterCloseValveTimeout: {
                id: 0x5011,
                type: ZCLDataTypes.uint16
            },
            motorTravelCalibrationStatus: {
                id: 0x5012,
                type: ZCLDataTypes.uint8
            },
            motorRunStatus: {
                id: 0x5013,
                type: ZCLDataTypes.uint8
            },
            motorTravelCalibrationAction: {
                id: 0x5001,
                type: ZCLDataTypes.uint8
            },
        };
    }

    static get COMMANDS() {
        return {
            protocolData: {
                id: 0x01,
                manufacturerId: 0x1286,
                args: {
                    data: ZCLDataTypes.buffer
                }
            },
            // cmdId 0x03 — device status/heartbeat sent periodically by the energy meter.
            // Declaring it here prevents unknown_command_received:3 errors.
            statusReport: {
                id: 0x03,
                manufacturerId: 0x1286,
                args: {
                    data: ZCLDataTypes.buffer
                }
            },
            protocolDataResponse: {
                id: 0x0B,
                manufacturerId: 0x1286,
                args: {
                    status: ZCLDataTypes.uint8,
                    reserved: ZCLDataTypes.uint8,
                }
            }
        };
    }

    // Suppress device→hub protocolData response ACK and default response — prevents unknown_command errors
    protocolDataResponse() {}
    onDefaultResponse() {}
    // statusReport (cmdId 0x03) heartbeats from the device are handled by the
    // BoundCluster in device.js — no handler needed here.
}

module.exports = SonoffCluster;

/**
 * TODO
 *
 * Reset Consumption
 *
 * Sniffer (iHost):
 * Cluster 0xFC11
 * Client -> Server
 * Frame: 01 01 03
 *
 * Command ID 0x03 resets accumulated energy.
 * Implement after confirming behavior with non-zero meter values.
 */