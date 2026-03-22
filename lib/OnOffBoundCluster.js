'use strict';

/**
 * @file OnOffBoundCluster.js
 * @description BoundCluster implementation for the ZCL OnOff cluster (0x0006).
 * Handles physical button commands sent from Zigbee devices to the coordinator
 * via the bound cluster mechanism (device-initiated commands).
 */

const { BoundCluster } = require('zigbee-clusters');

/**
 * @class OnOffBoundCluster
 * @extends BoundCluster
 *
 * @example
 * const bc = new OnOffBoundCluster({
 *   onSetOn:  () => device.setCapabilityValue('onoff', true),
 *   onSetOff: () => device.setCapabilityValue('onoff', false),
 *   onToggle: () => device.setCapabilityValue('onoff', !device.getCapabilityValue('onoff')),
 * });
 * zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, bc);
 */
class OnOffBoundCluster extends BoundCluster {

  /**
   * @param {object} opts
   * @param {Function} [opts.onSetOn]   - Called when device sends SetOn command.
   * @param {Function} [opts.onSetOff]  - Called when device sends SetOff command.
   * @param {Function} [opts.onToggle]  - Called when device sends Toggle command.
   */
  constructor({ onSetOn, onSetOff, onToggle } = {}) {
    super();
    this._onSetOn  = onSetOn;
    this._onSetOff = onSetOff;
    this._onToggle = onToggle;
  }

  /** Handle SetOn command from device. */
  setOn() { if (this._onSetOn) this._onSetOn(); }

  /** @alias setOn */
  on() { if (this._onSetOn) this._onSetOn(); }

  /** Handle SetOff command from device. */
  setOff() { if (this._onSetOff) this._onSetOff(); }

  /** @alias setOff */
  off() { if (this._onSetOff) this._onSetOff(); }

  /** Handle Toggle command from device. */
  toggle() { if (this._onToggle) this._onToggle(); }
}

module.exports = OnOffBoundCluster;
