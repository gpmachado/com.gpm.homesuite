'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class EkazaSirenDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');

    // Action: play with specific melody + duration (volume from device Settings)
    this.homey.flow
      .getActionCard('siren_play')
      .registerRunListener(async (args) => {
        const melody   = Number(args.melody);
        const duration = Number(args.duration);
        const volume   = Number(args.device.getSetting('alarmvolume') ?? '2');
        await args.device._playSiren(melody, volume, duration);
      });

    // Action: stop siren immediately
    this.homey.flow
      .getActionCard('siren_stop')
      .registerRunListener(async (args) => {
        await args.device._stopSiren();
      });

    // Condition: is siren currently playing?
    this.homey.flow
      .getConditionCard('is_playing')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('onoff') === true;
      });
  }

}

module.exports = EkazaSirenDriver;
