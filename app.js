'use strict';

const Homey = require('homey');
const { debug } = require('zigbee-clusters');
const { ZCL_DEBUG } = require('./lib/constants');

const { registerCustomClusters } = require('./lib/clusterRegistry');
registerCustomClusters();

// ─── ZCL debug verbosity ──────────────────────────────────────────────────────
// true  → verbose ZCL frame logging (useful during development / sniffing)
// false → silent (production)
// Flip ZCL_DEBUG in lib/constants.js instead of hunting across every device.js.
debug(ZCL_DEBUG);
// ─────────────────────────────────────────────────────────────────────────────


class MyHomeSuiteApp extends Homey.App {

  async onInit() {
    this.log('HomeSuite initiating...');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // Condition: availability is on (reads available state natively)
    this.homey.flow.getConditionCard('availability_is_on')
      .registerRunListener(async ({ device }) => {
        return device.getAvailable();
      });
  }

};

module.exports = MyHomeSuiteApp;
