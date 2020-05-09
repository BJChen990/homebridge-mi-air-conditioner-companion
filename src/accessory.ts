import {
  AccessoryPlugin,
  Logger,
  API,
  AccessoryConfig,
  CharacteristicEventTypes,
  CharacteristicValue,
  CharacteristicSetCallback,
  Characteristic,
  Formats,
  Service,
  CharacteristicGetCallback,
} from 'homebridge';
import {
  AirConditionerState,
  AirConditionerCompanionDevice,
  OperationMode,
  On,
  RotationSpeed as MiRotationSpeed,
  DEFAULT_STATE,
} from './device';
import { MiIONetwork, MiIOClient } from 'simple-miio';

const INTERVAL_TIMEOUT = 3000;

const networkClient = new MiIONetwork();

interface CompanionConfig extends AccessoryConfig {
  name: string;
  token: string;
  ip: string;
}

const {
  Active,
  RotationSpeed,
  SwingMode,
  CurrentHeatingCoolingState,
  TargetHeatingCoolingState,
  TargetTemperature,
  TemperatureDisplayUnits,
} = Characteristic;

export class AirConditionerCompanionAccessory implements AccessoryPlugin {
  public readonly name: string;
  private readonly config: AccessoryConfig;
  private readonly device: AirConditionerCompanionDevice;
  private status: AirConditionerState = DEFAULT_STATE;

  private readonly thermostatService: Service;
  private readonly fanService: Service;

  constructor(
    private readonly logger: Logger,
    config: AccessoryConfig,
    private readonly homebridge: API,
  ) {
    this.config = config as CompanionConfig;
    this.name = this.config.name;
    const client = new MiIOClient(networkClient, this.config.token, this.config.ip);
    this.device = new AirConditionerCompanionDevice(client);

    const { Thermostat, Fanv2 } = this.homebridge.hap.Service;
    this.thermostatService = new Thermostat(`${this.config.name}`, 'Thermostat');
    this.fanService = new Fanv2(`${this.config.name}`, 'Fan');

    this.homebridge.on('didFinishLaunching', () => {
      const intervalId = setInterval(this.udpateStatus, INTERVAL_TIMEOUT);
      this.homebridge.on('shutdown', () => {
        clearInterval(intervalId);
      });
    });
  }

  private udpateStatus = async () => {
    const { companionStatus } = await this.device.getProperties();
    const { thermostatService, fanService } = this;
    const { Characteristic } = this.homebridge.hap;
    const { TargetFanState, CurrentTemperature, TargetTemperature } = Characteristic;
    const shouldUpdate = Object.keys(this.status).some(
      key =>
        companionStatus[key as keyof AirConditionerState] !==
        this.status[key as keyof AirConditionerState],
    );
    this.status = companionStatus;

    if (!shouldUpdate) {
      return;
    }
    thermostatService.updateCharacteristic(CurrentTemperature, this.targetTemperature);
    thermostatService.updateCharacteristic(TargetTemperature, this.targetTemperature);
    thermostatService.updateCharacteristic(TargetHeatingCoolingState, this.targetTemperature);
    thermostatService.updateCharacteristic(
      CurrentHeatingCoolingState,
      this.currentHeatingCoolingState,
    );
    fanService.updateCharacteristic(Active, this.active);
    fanService.updateCharacteristic(TargetFanState, this.targetTemperature);
    fanService.updateCharacteristic(RotationSpeed, this.rotationSpeed);
    fanService.updateCharacteristic(SwingMode, this.swingMode);
    fanService.updateCharacteristic(Active, this.active);
  };

  get targetTemperature() {
    return this.status.temperature;
  }

  get active() {
    return this.status.power === On.ON ? Active.ACTIVE : Active.INACTIVE;
  }

  get currentHeatingCoolingState() {
    const { power, operationMode } = this.status;
    if (power === On.OFF) {
      return CurrentHeatingCoolingState.OFF;
    }
    switch (operationMode) {
      case OperationMode.SCAVENGER:
      case OperationMode.DEHUMIDIFICATION:
      case OperationMode.HEATING:
        return TargetHeatingCoolingState.HEAT;
      case OperationMode.AUTO:
      case OperationMode.COOLING:
        return TargetHeatingCoolingState.COOL;
    }
  }

  get targetHeatingCoolingState() {
    const { power, operationMode } = this.status;
    if (power === On.OFF) {
      return TargetHeatingCoolingState.OFF;
    }
    switch (operationMode) {
      case OperationMode.AUTO:
      case OperationMode.SCAVENGER:
      case OperationMode.DEHUMIDIFICATION:
        return TargetHeatingCoolingState.AUTO;
      case OperationMode.HEATING:
        return TargetHeatingCoolingState.HEAT;
      case OperationMode.COOLING:
        return TargetHeatingCoolingState.COOL;
    }
  }

  get targetFanState() {
    const { TargetFanState } = this.homebridge.hap.Characteristic;
    switch (this.status.rotationSpeed) {
      case MiRotationSpeed.AUTO:
        return TargetFanState.AUTO;
        break;
      case MiRotationSpeed.FAST:
      case MiRotationSpeed.NORMAL:
      case MiRotationSpeed.SLOW:
        return TargetFanState.MANUAL;
    }
  }

  get rotationSpeed() {
    const { power, rotationSpeed } = this.status;
    if (power === On.OFF) {
      return 0;
    }
    switch (rotationSpeed) {
      case MiRotationSpeed.AUTO:
      case MiRotationSpeed.FAST:
        return 3;
      case MiRotationSpeed.NORMAL:
        return 2;
      case MiRotationSpeed.SLOW:
        return 1;
    }
  }

  get swingMode() {
    return this.status.swingMode === On.ON ? SwingMode.SWING_ENABLED : SwingMode.SWING_DISABLED;
  }

  private getTargetHeatingCoolingState = (callback: CharacteristicGetCallback) =>
    callback(null, this.targetHeatingCoolingState);

  private setTargetHeatingCoolingState = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      this.logger.debug('set target cooler state: %s', state);
      if (state === this.targetHeatingCoolingState) {
        this.logger.debug('target cooler state is the same, aborting');
        callback(null);
        return;
      }
      const { TargetHeatingCoolingState } = Characteristic;
      switch (state) {
        case TargetHeatingCoolingState.OFF:
          await this.device.setPower(On.OFF);
          this.status.power = On.OFF;
          break;
        case TargetHeatingCoolingState.COOL:
          await this.device.setAirConditionerMode(OperationMode.COOLING);
          this.status.operationMode = OperationMode.COOLING;
          break;
        case TargetHeatingCoolingState.AUTO:
          await this.device.setAirConditionerMode(OperationMode.AUTO);
          this.status.operationMode = OperationMode.AUTO;
          break;
      }
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private getTargetTemperature = async (callback: CharacteristicGetCallback) =>
    callback(null, this.targetTemperature);

  private setTargetTemperature = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      this.logger.debug('set target temperature: %s', state);
      await this.device.setTargetTemperature(state as number);
      this.status.temperature = state as number;
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private setActive = async (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
    const targetState = state === Characteristic.Active.ACTIVE ? On.ON : On.OFF;
    if (targetState === this.status.power) {
      return callback(null);
    }
    try {
      this.logger.debug('set active: %s', state);
      const power = state === Characteristic.Active.ACTIVE ? On.ON : On.OFF;
      await this.device.setPower(power);
      this.status.power = power;
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private getSwingMode = async (callback: CharacteristicGetCallback) =>
    callback(null, this.swingMode);

  private setSwingMode = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      const { SwingMode } = Characteristic;
      this.logger.debug('set swing mode: %s', state);
      if (state === this.swingMode) {
        this.logger.debug('target swing mode is the same as current one. Aborting');
        return callback(null);
      }
      const swingMode = state === SwingMode.SWING_ENABLED ? On.ON : On.OFF;
      await this.device.setSwing(swingMode);
      this.status.swingMode = swingMode;
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private getTargetFanState = (callback: CharacteristicGetCallback) =>
    callback(null, this.targetFanState);

  private setTargetFanState = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      const { TargetFanState } = Characteristic;
      this.logger.debug('set target fan state: %s', state);
      const rotationSpeed =
        state === TargetFanState.MANUAL ? MiRotationSpeed.NORMAL : MiRotationSpeed.AUTO;
      await this.device.setRotationSpeed(rotationSpeed);
      this.status.rotationSpeed = rotationSpeed;
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private getRotationSpeed = (callback: CharacteristicGetCallback) =>
    callback(null, this.rotationSpeed);

  private setRotationSpeed = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      this.logger.debug('set rotation speed: %s', state);
      let rotationSpeed: MiRotationSpeed;
      switch (state) {
        case 0:
          this.device.setPower(On.OFF);
          this.status.power = On.OFF;
          callback(null);
          return;
        case 1:
          rotationSpeed = MiRotationSpeed.SLOW;
          break;
        case 2:
          rotationSpeed = MiRotationSpeed.NORMAL;
          break;
        case 3:
          rotationSpeed = MiRotationSpeed.FAST;
          break;
        default:
          throw new Error('Invalid target rotation speed: ' + state);
      }
      await this.device.setRotationSpeed(rotationSpeed);
      this.status.rotationSpeed = rotationSpeed;
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  getCurrentTemperature = (callback: CharacteristicGetCallback) =>
    callback(null, this.status.temperature);

  getServices() {
    const { Characteristic } = this.homebridge.hap;
    this.thermostatService
      .getCharacteristic(TemperatureDisplayUnits)
      .setProps({ validValues: [TemperatureDisplayUnits.CELSIUS] })
      .setValue(TemperatureDisplayUnits.CELSIUS);
    this.thermostatService
      .getCharacteristic(TargetHeatingCoolingState)
      .setProps({
        validValues: [
          TargetHeatingCoolingState.OFF,
          TargetHeatingCoolingState.COOL,
          TargetHeatingCoolingState.AUTO,
        ],
      })
      .on(CharacteristicEventTypes.GET, this.getTargetHeatingCoolingState)
      .on(CharacteristicEventTypes.SET, this.setTargetHeatingCoolingState);
    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on(CharacteristicEventTypes.GET, this.getCurrentTemperature);
    this.thermostatService
      .getCharacteristic(TargetTemperature)
      .setProps({ maxValue: 30, minValue: 16, minStep: 1 })
      .on(CharacteristicEventTypes.GET, this.getTargetTemperature)
      .on(CharacteristicEventTypes.SET, this.setTargetTemperature);

    this.fanService.getCharacteristic(Active).on(CharacteristicEventTypes.SET, this.setActive);
    this.fanService
      .addCharacteristic(Characteristic.TargetFanState)
      .on(CharacteristicEventTypes.GET, this.getTargetFanState)
      .on(CharacteristicEventTypes.SET, this.setTargetFanState);

    this.fanService
      .addCharacteristic(Characteristic.SwingMode)
      .on(CharacteristicEventTypes.GET, this.getSwingMode)
      .on(CharacteristicEventTypes.SET, this.setSwingMode);
    this.fanService
      .addCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 3, minStep: 1, format: Formats.INT })
      .on(CharacteristicEventTypes.GET, this.getRotationSpeed)
      .on(CharacteristicEventTypes.SET, this.setRotationSpeed);

    return [this.thermostatService, this.fanService];
  }
}
