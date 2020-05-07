import { API } from 'homebridge';
import { AirConditionerCompanionAccessory } from './accessory';

export const install = (homebridge: API) => {
  homebridge.registerAccessory('MiAirConditionerCompanion', AirConditionerCompanionAccessory);
};

export default install;
