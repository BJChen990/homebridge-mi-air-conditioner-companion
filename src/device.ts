import { MiIOClient } from 'simple-miio';
import { zip } from 'lodash';

export type Entries<T> = { [P in keyof T]: [P, T[P]] }[keyof T];

export const enum PropertyKeys {
  AIR_CONDITIONER_MODE = 'ac_mode',
  AIR_CONDITIONER_STATE = 'ac_state',
  LOAD_POWER = 'load_power',
  INDICATOR_LIGHT = 'en_nnlight',
  QUICK_COOL_STATE = 'quick_cool_state',
  SLEEP_STATE = 'sleep_state',
  LIST_CRC32 = 'list_crc32',
}

export const enum OperationMode {
  COOLING = 'cool',
  HEATING = 'heat',
  AUTO = 'auto',
  SCAVENGER = 'wind',
  DEHUMIDIFICATION = 'dry',
}

export function parseOperationMode(mode: number) {
  switch (mode) {
    case 0:
      return OperationMode.COOLING;
    case 1:
      return OperationMode.HEATING;
    case 2:
      return OperationMode.AUTO;
    case 3:
      return OperationMode.SCAVENGER;
    case 4:
      return OperationMode.DEHUMIDIFICATION;
    default:
      throw new Error('Received invalid mode: ' + mode);
  }
}

export const enum RotationSpeed {
  AUTO = 'auto_fan',
  SLOW = 'small_fan',
  NORMAL = 'medium_fan',
  FAST = 'large_fan',
}

export function parseRotationSpeed(speed: number) {
  switch (speed) {
    case 0:
      return RotationSpeed.AUTO;
    case 1:
      return RotationSpeed.SLOW;
    case 2:
      return RotationSpeed.NORMAL;
    case 3:
      return RotationSpeed.FAST;
    default:
      throw new Error('Invalid rotation speed: ' + speed);
  }
}

export const enum On {
  ON = 'on',
  OFF = 'off',
}

export function parsePower(power: number) {
  switch (power) {
    case 0:
      return On.ON;
    case 1:
      return On.OFF;
    default:
      throw new Error('Invalid power value: ' + power);
  }
}

export function parseSwingMode(swing: number) {
  switch (swing) {
    case 0:
      return On.ON;
    case 999:
    default:
      return On.OFF;
  }
}

const STATUS_SEPARATOR = '_';

export interface AirConditionerState {
  operationMode: OperationMode;
  power: On;
  swingMode: On;
  rotationSpeed: RotationSpeed;
  temperature: number;
}

export const DEFAULT_STATE: AirConditionerState = {
  operationMode: OperationMode.AUTO,
  power: On.OFF,
  swingMode: On.OFF,
  rotationSpeed: RotationSpeed.AUTO,
  temperature: 30,
};

const enum StateKeyShort {
  POWER = 'P',
  MODE = 'M',
  SWING = 'D',
  ROTATION_SPEED = 'S',
  TEMPERATURE = 'T',
}

export function parseState(state: string) {
  return (
    state
      .split(STATUS_SEPARATOR)
      // ["P1", "M0", ...]
      .map<[string, number]>(state => [state.slice(0, 1), parseInt(state.slice(1), 10)])
      .map(
        ([shortKey, value]): Entries<AirConditionerState> => {
          switch (shortKey) {
            case StateKeyShort.TEMPERATURE:
              return ['temperature', value];
            case StateKeyShort.ROTATION_SPEED:
              return ['rotationSpeed', parseRotationSpeed(value)];
            case StateKeyShort.POWER:
              return ['power', parsePower(value)];
            case StateKeyShort.MODE:
              return ['operationMode', parseOperationMode(value)];
            case StateKeyShort.SWING:
              return ['swingMode', parseSwingMode(value)];
            default:
              throw new Error('Unexpected key found: ' + shortKey);
          }
        },
      )
      .reduce((accu, [key, value]) => ({ ...accu, [key]: value }), {} as AirConditionerState)
  );
}

const enum Property {
  AIR_CONDITIONER_MODE = 'ac_mode',
  AIR_CONDITIONER_STATE = 'ac_state',
  LOAD_POWER = 'load_power',
  INDICATOR_LIGHT = 'en_nnlight',
  QUICK_COOL_STATE = 'quick_cool_state',
  SLEEP_STATE = 'sleep_state',
  LIST_CRC32 = 'list_crc32',
}

const DEFAULT_GET_PROPERTY_LIST = [
  Property.AIR_CONDITIONER_MODE,
  Property.AIR_CONDITIONER_STATE,
  Property.LOAD_POWER,
  Property.INDICATOR_LIGHT,
  Property.QUICK_COOL_STATE,
  Property.SLEEP_STATE,
  Property.LIST_CRC32,
];

// TODO(Benji): Support more status
export interface GetPropertyResponse {
  companionStatus: AirConditionerState;
}

interface DetectIRCodeResult {
  key: string;
  length: number;
  code: string;
}

export class AirConditionerCompanionDevice {
  constructor(private readonly client: MiIOClient) {}

  /**
   * Parse the result get from the `Property.AIR_CONDITIONER_STATE`.
   * @param string state, something like "P1_M0_T20_S3_D0"
   */
  async getProperties(props: Property[] = DEFAULT_GET_PROPERTY_LIST) {
    const { result } = await this.client.send<Property[], (string | number)[]>('get_prop', props);
    return zip(props, result)
      .map(([key, value]): Entries<GetPropertyResponse> | undefined => {
        switch (key) {
          case Property.AIR_CONDITIONER_STATE:
            return ['companionStatus', parseState(value as string)];
          default:
            return undefined;
        }
      })
      .reduce<Partial<GetPropertyResponse>>((all, entry) => {
        if (!entry) {
          return all;
        }
        return { ...all, [entry[0]]: entry[1] };
      }, {}) as GetPropertyResponse;
  }

  setPower(power: On) {
    return this.client.simpleSend('set_power', [power]);
  }

  setRotationSpeed(rotationSpeed: RotationSpeed) {
    return this.client.simpleSend('set_fan_level', [rotationSpeed]);
  }

  setSwing(swingMode: On) {
    return this.client.simpleSend('set_ver_swing', [swingMode]);
  }

  setTargetTemperature(temperature: number) {
    return this.client.simpleSend('set_tar_temp', [temperature]);
  }

  setAirConditionerMode(mode: OperationMode) {
    return this.client.send('set_mode', [mode]);
  }

  startIRDetection(taskId: string) {
    return this.client.simpleSend('miIO.ir_learn', { key: taskId });
  }

  async readIRDetectionResult(taskId: string) {
    const { result } = await this.client.send<{ key: string }, DetectIRCodeResult>('miIO.ir_read', {
      key: taskId,
    });
    return result;
  }

  async stopIRDetection(taskId: string) {
    return this.client.simpleSend('miIO.ir_learn_stop', { key: taskId });
  }

  async sendIRCode(code: string, frequency: number = 38400) {
    return this.client.simpleSend('miIO.ir_play', { freq: frequency, code });
  }
}
