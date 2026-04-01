'use strict';

const Homey = require('homey');
const { debug } = require('zigbee-clusters');

const { registerCustomClusters } = require('./lib/clusterRegistry');
registerCustomClusters();

// ─── ZCL debug verbosity ──────────────────────────────────────────────────────
// true  → verbose ZCL frame logging (useful during development / sniffing)
// false → silent (production)
// Flip this ONE constant instead of hunting across every device.js.
const ZCL_DEBUG = false;
debug(ZCL_DEBUG);
// ─────────────────────────────────────────────────────────────────────────────


class MyHomeSuiteApp extends Homey.App {

  async onInit() {
    this.log('HomeSuite initiating...');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // Triggers: availability turned on/off — filter by device.
    // Homey resolves flow args as the same device singleton registered in the driver,
    // so reference equality (===) is reliable and avoids depending on device.id
    // which is only accessible inside the Homey runtime (not in node_modules).
    for (const id of ['availability_turned_on', 'availability_turned_off']) {
      this.homey.flow.getTriggerCard(id)
        .registerRunListener(async (args, state) => {
          const match = !args.device || args.device === state.device;
          this.log(`[FlowCard] ${id} | device=${args.device?.getName?.() ?? 'any'} match=${match}`);
          return match;
        });
    }

    // Condition: availability is on (reads available state natively)
    this.homey.flow.getConditionCard('availability_is_on')
      .registerRunListener(async ({ device }) => {
        return device.getAvailable();
      });
  }

};

module.exports = MyHomeSuiteApp;