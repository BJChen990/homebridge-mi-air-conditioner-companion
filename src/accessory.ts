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
    const { thermostatService } = this;
    const { Characteristic } = this.homebridge.hap;
    const { TargetFanState, CurrentTemperature, TargetTemperature } = Characteristic;
    this.logger.debug('latest status: %s', companionStatus);
    if (companionStatus.temperature !== this.status.temperature) {
      this.logger.debug('update target temperature -> %s', companionStatus.temperature);
      thermostatService.updateCharacteristic(CurrentTemperature, companionStatus.temperature);
      thermostatService.updateCharacteristic(TargetTemperature, companionStatus.temperature);
    }
    if (companionStatus.power !== this.status.power) {
      this.logger.debug('update power -> %s', companionStatus.power);
      const active = companionStatus.power === On.ON;
      thermostatService.updateCharacteristic(
        TargetHeatingCoolingState,
        active ? TargetHeatingCoolingState.AUTO : TargetHeatingCoolingState.OFF,
      );
      this.fanService.updateCharacteristic(Active, active ? Active.ACTIVE : Active.INACTIVE);
    }
    if (companionStatus.rotationSpeed !== this.status.rotationSpeed) {
      this.logger.debug('update rotation speed -> %s', companionStatus.rotationSpeed);
      switch (companionStatus.rotationSpeed) {
        case MiRotationSpeed.AUTO:
          this.fanService.updateCharacteristic(TargetFanState, TargetFanState.AUTO);
          this.fanService.updateCharacteristic(RotationSpeed, 3);
          break;
        case MiRotationSpeed.FAST:
          this.fanService.updateCharacteristic(TargetFanState, TargetFanState.MANUAL);
          this.fanService.updateCharacteristic(RotationSpeed, 3);
          break;
        case MiRotationSpeed.NORMAL:
          this.fanService.updateCharacteristic(TargetFanState, TargetFanState.MANUAL);
          this.fanService.updateCharacteristic(RotationSpeed, 2);
          break;
        case MiRotationSpeed.SLOW:
          this.fanService.updateCharacteristic(TargetFanState, TargetFanState.MANUAL);
          this.fanService.updateCharacteristic(RotationSpeed, 1);
          break;
      }
    }
    if (companionStatus.swingMode !== this.status.swingMode) {
      this.logger.debug('update swing mode -> %s', companionStatus.swingMode);
      this.fanService.updateCharacteristic(
        SwingMode,
        companionStatus.swingMode === On.ON ? SwingMode.SWING_ENABLED : SwingMode.SWING_DISABLED,
      );
    }
    if (companionStatus.operationMode !== this.status.operationMode) {
      this.logger.debug('update operation mode -> %s', companionStatus.operationMode);
      if (companionStatus.power === On.OFF) {
        this.thermostatService.updateCharacteristic(
          CurrentHeatingCoolingState,
          CurrentHeatingCoolingState.OFF,
        );
        this.fanService.updateCharacteristic(Active, Active.INACTIVE);
      } else {
        switch (companionStatus.operationMode) {
          case OperationMode.AUTO:
          case OperationMode.COOLING:
          case OperationMode.DEHUMIDIFICATION:
          case OperationMode.SCAVENGER:
            this.thermostatService.updateCharacteristic(
              CurrentHeatingCoolingState,
              CurrentHeatingCoolingState.COOL,
            );
            break;
          case OperationMode.HEATING:
            this.thermostatService.updateCharacteristic(
              CurrentHeatingCoolingState,
              CurrentHeatingCoolingState.HEAT,
            );
            break;
        }
      }
    }
    this.status = companionStatus;
  };

  private setTargetHeatingCoolingState = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      this.logger.debug('set target cooler state: %s', state);
      const { TargetHeatingCoolingState } = Characteristic;
      switch (state) {
        case TargetHeatingCoolingState.OFF:
          await this.device.setPower(On.OFF);
          break;
        case TargetHeatingCoolingState.COOL:
          await this.device.setAirConditionerMode(OperationMode.COOLING);
          break;
        case TargetHeatingCoolingState.AUTO:
          await this.device.setAirConditionerMode(OperationMode.AUTO);
          break;
      }
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private setTargetTemperature = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      this.logger.debug('set target temperature: %s', state);
      await this.device.setTargetTemperature(state as number);
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
      await this.device.setPower(state === Characteristic.Active.ACTIVE ? On.ON : On.OFF);
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private setSwingMode = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      const { SwingMode } = Characteristic;
      this.logger.debug('set swing mode: %s', state);
      await this.device.setSwing(state === SwingMode.SWING_ENABLED ? On.ON : On.OFF);
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private setTargetFanState = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      const { TargetFanState } = Characteristic;
      this.logger.debug('set target fan state: %s', state);
      await this.device.setRotationSpeed(
        state === TargetFanState.MANUAL ? MiRotationSpeed.NORMAL : MiRotationSpeed.AUTO,
      );
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  private setRotationSpeed = async (
    state: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) => {
    try {
      this.logger.debug('set rotation speed: %s', state);
      switch (state) {
        case 0:
          await this.device.setRotationSpeed(MiRotationSpeed.AUTO);
          break;
        case 1:
          await this.device.setRotationSpeed(MiRotationSpeed.SLOW);
          break;
        case 2:
          await this.device.setRotationSpeed(MiRotationSpeed.NORMAL);
          break;
        case 3:
          await this.device.setRotationSpeed(MiRotationSpeed.FAST);
          break;
      }
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
      .on(CharacteristicEventTypes.SET, this.setTargetHeatingCoolingState);
    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on(CharacteristicEventTypes.GET, this.getCurrentTemperature);
    this.thermostatService
      .getCharacteristic(TargetTemperature)
      .setProps({ maxValue: 30, minValue: 16, minStep: 1 })
      .on(CharacteristicEventTypes.SET, this.setTargetTemperature);

    this.fanService.getCharacteristic(Active).on(CharacteristicEventTypes.SET, this.setActive);
    this.fanService
      .addCharacteristic(Characteristic.TargetFanState)
      .on(CharacteristicEventTypes.SET, this.setTargetFanState);

    this.fanService
      .addCharacteristic(Characteristic.SwingMode)
      .on(CharacteristicEventTypes.SET, this.setSwingMode);
    this.fanService
      .addCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 3, minStep: 1, format: Formats.INT })
      .on(CharacteristicEventTypes.SET, this.setRotationSpeed);

    return [this.thermostatService, this.fanService];
  }
}
