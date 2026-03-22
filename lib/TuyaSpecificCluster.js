'use strict';

/**
 * TuyaSpecificCluster - Optimized Version
 * 
 * Defines the Tuya-specific Zigbee cluster (0xEF00) and its communication protocol.
 * This cluster handles all Tuya proprietary commands including datapoints, reporting,
 * time synchronization, and heartbeat monitoring.
 * 
 * Key features:
 * - Bidirectional datapoint communication (read/write device state)
 * - Device reporting and status updates
 * - Time synchronization (0x24 command)
 * - Heartbeat monitoring (0x11 command)
 * - Data query support (request all datapoints)
 * 
 * @version 3.1.1 - Enhanced: flexible time sync, removed unused helpers
 */

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

// No attributes defined for Tuya cluster - all communication is command-based
const ATTRIBUTES = {};

/**
 * Standard datapoint argument structure
 * Used by multiple commands: datapoint, reporting, response, reportingConfiguration
 * @private
 */
const STANDARD_DATAPOINT_ARGS = {
    status: ZCLDataTypes.uint8,      // Command status (0 = request)
    transid: ZCLDataTypes.uint8,     // Transaction ID (incremental)
    dp: ZCLDataTypes.uint8,          // Datapoint ID (device-specific)
    datatype: ZCLDataTypes.uint8,    // Data type (0=raw, 1=bool, 2=value, 3=string, 4=enum, 5=bitmap)
    length: ZCLDataTypes.uint16,     // Data length in bytes
    data: ZCLDataTypes.buffer        // Actual data payload
};

/**
 * Command definitions for Tuya-specific Zigbee communication
 * Each command follows the Tuya protocol specification for the 0xEF00 cluster
 */
const COMMANDS = {
    /**
     * 0x00: Datapoint command (bidirectional)
     * Used to read/write device datapoints (DP)
     * Direction: Coordinator ↔ Device
     */
    datapoint: {
        id: 0x00,
        args: STANDARD_DATAPOINT_ARGS
    },
    
    /**
     * 0x01: Reporting command (device → coordinator)
     * Device reports datapoint changes autonomously
     * Direction: Device → Coordinator
     */
    reporting: {
        id: 0x01,
        args: STANDARD_DATAPOINT_ARGS
    },
    
    /**
     * 0x02: Response command (device → coordinator)
     * Device response to a datapoint write command
     * Direction: Device → Coordinator
     */
    response: {
        id: 0x02,
        args: STANDARD_DATAPOINT_ARGS
    },
    
    /**
     * 0x03: Data query command (coordinator → device)
     * Request all datapoints from device
     * Direction: Coordinator → Device
     */
    dataQuery: {
        id: 0x03,
        args: {
            transid: ZCLDataTypes.uint8      // Transaction ID only
        }
    },
    
    /**
     * 0x06: Reporting configuration
     * Configure device reporting behavior (not time sync!)
     * Direction: Coordinator ↔ Device
     */
    reportingConfiguration: {
        id: 0x06,
        args: STANDARD_DATAPOINT_ARGS
    },
    
    /**
     * 0x11: Heartbeat command (device → coordinator)
     * Device sends periodic keepalive messages
     * Payload: 3 bytes [status, value, marker]
     * Direction: Device → Coordinator
     */
    heartbeat: {
        id: 0x11,
        args: {
            data: ZCLDataTypes.buffer        // 3-byte payload
        }
    },
    
    /**
     * 0x24: Time synchronization command (bidirectional)
     * 
     * Device → Coordinator (time request):
     * - Empty payload or short (2 bytes: 0x00 0x08 / 0x00 0x06 / 0x00 0x00)
     * - Device sends 0x24 when it needs time update
     * 
     * Coordinator → Device (time response):
     * - Format depends on device type:
     *   • Most devices: 8 bytes [UTC(4 BE)][Local(4 BE)]
     *   • Devices with display (TRVs, thermostats, clocks): 
     *     10 bytes [0x00, 0x08, UTC(4 BE), Local(4 BE)]
     * - Both timestamps are Unix epoch seconds (32-bit big-endian)
     * - BEST PRACTICE: Detect format from request payload (see TuyaSpecificClusterDevice.sendTimeResponse)
     * 
     * Direction: Coordinator ↔ Device
     */
    setTime: {
        id: 0x24,
        args: {
            payload: ZCLDataTypes.buffer     // Variable: 8 or 10 bytes depending on device
        }
    },
};

/**
 * TuyaSpecificCluster Class
 * 
 * Implements the Tuya-specific Zigbee cluster with event handling
 * for all Tuya protocol commands. Extends the base Cluster class
 * from zigbee-clusters library.
 */
class TuyaSpecificCluster extends Cluster {
    
    /**
     * Cluster ID for Tuya-specific communication
     * @returns {number} 0xEF00 (61184 decimal)
     */
    static get ID() {
        return 61184;  // 0xEF00 - Tuya manufacturer-specific cluster
    }

    /**
     * Cluster name for identification
     * @returns {string} 'tuya'
     */
    static get NAME() {
        return 'tuya';
    }

    /**
     * Cluster attributes (none defined for Tuya)
     * @returns {Object} Empty attributes object
     */
    static get ATTRIBUTES() {
        return ATTRIBUTES;
    }

    /**
     * Cluster commands definition
     * @returns {Object} Commands object with all Tuya protocol commands
     */
    static get COMMANDS() {
        return COMMANDS;
    }

    // ========================================
    // Event Handlers
    // ========================================

    /**
     * Handle incoming datapoint command
     * Emits 'datapoint' event with the received data
     */
    onDatapoint(response) {
        try {
            this.emit('datapoint', response);
        } catch (error) {
            this.error('Error handling datapoint event:', error);
        }
    }

    /**
     * Handle incoming reporting command
     * Emits 'reporting' event when device reports datapoint changes
     */
    onReporting(response) {
        try {
            this.emit('reporting', response);
        } catch (error) {
            this.error('Error handling reporting event:', error);
        }
    }

    /**
     * Handle incoming response command
     * Emits 'response' event with device response
     */
    onResponse(response) {
        try {
            this.emit('response', response);
        } catch (error) {
            this.error('Error handling response event:', error);
        }
    }

    /**
     * Handle data query command
     * Emits 'dataQuery' event when query is received
     */
    onDataQuery(response) {
        try {
            this.emit('dataQuery', response);
        } catch (error) {
            this.error('Error handling data query event:', error);
        }
    }

    /**
     * Handle reporting configuration command
     * Emits 'reportingConfiguration' event
     */
    onReportingConfiguration(response) {
        try {
            this.emit('reportingConfiguration', response);
        } catch (error) {
            this.error('Error handling reporting configuration event:', error);
        }
    }

    /**
     * Parse heartbeat payload into structured format
     * @param {Object} heartbeat - Raw heartbeat data
     * @returns {Object} Parsed heartbeat or original if invalid
     * @private
     */
    _parseHeartbeat(heartbeat) {
        if (!heartbeat?.data || heartbeat.data.length < 3) {
            return heartbeat; // Return original if invalid
        }
        
        return {
            status: heartbeat.data[0],
            value: heartbeat.data[1],
            marker: heartbeat.data[2],
            raw: heartbeat.data
        };
    }

    /**
     * Handle heartbeat command from device
     * Parses 3-byte heartbeat payload and emits structured data
     * 
     * Heartbeat format:
     * Byte 0: Status
     * Byte 1: Value
     * Byte 2: Marker
     */
    onHeartbeat(heartbeat) {
        try {
            const parsed = this._parseHeartbeat(heartbeat);
            this.emit('heartbeat', parsed);
        } catch (error) {
            this.error('Error handling heartbeat event:', error);
        }
    }

    /**
     * Handle time synchronization request from device
     * Emits 'timeRequest' event when device requests time sync
     * 
     * Device sends 0x24 command when it needs time update.
     * Coordinator should respond with 10-byte payload containing
     * prefix (0x00, 0x08) + UTC and local timestamps.
     */
    onSetTime(request) {
        try {
            this.emit('timeRequest', request);
        } catch (error) {
            this.error('Error handling time sync request:', error);
        }
    }

    /**
     * Override bind method to register command handlers
     * Ensures all Tuya commands are properly routed to event handlers
     */
    bind() {
        super.bind();
        
        // Command handler map for efficient routing
        const commandHandlers = {
            0x00: this.onDatapoint.bind(this),
            0x01: this.onReporting.bind(this),
            0x02: this.onResponse.bind(this),
            0x03: this.onDataQuery.bind(this),
            0x06: this.onReportingConfiguration.bind(this),
            0x11: this.onHeartbeat.bind(this),
            0x24: this.onSetTime.bind(this)
        };
        
        // Register handlers for incoming Tuya commands
        this.on('command', (command) => {
            try {
                // Validate command structure
                if (!command || command.id === undefined) {
                    this.error('Invalid command received: missing command or id');
                    return;
                }
                
                const handler = commandHandlers[command.id];
                if (handler) {
                    handler(command);
                } else {
                    this.log(`Unknown Tuya command received: 0x${command.id.toString(16)}`);
                }
            } catch (error) {
                this.error('Error processing Tuya command:', error);
            }
        });
    }
}

// Register cluster with zigbee-clusters library

module.exports = TuyaSpecificCluster;
