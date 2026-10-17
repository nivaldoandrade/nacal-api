import { ValueOf } from '@shared/utils/ValueOf';

export class Meal {
  public static readonly MAX_ATTEMPS: number = 2;

  readonly id: string;

  readonly accountId: string;

  status: Meal.StatusType;

  readonly inputFileKey: string;

  readonly inputType: Meal.InputType;

  readonly timeZone: string;

  name: string;

  attempts: number;

  icon: string;

  foods: Meal.FoodType[];

  readonly createdAt: Date;

  constructor(attr: Meal.Attributes) {
    this.id = attr.id;
    this.accountId = attr.accountId;
    this.status = attr.status;
    this.inputFileKey = attr.inputFileKey;
    this.inputType = attr.inputType;
    this.timeZone = attr.timeZone ?? '';
    this.attempts = attr.attempts ?? 0;
    this.name = attr.name ?? '';
    this.icon = attr.icon ?? '';
    this.foods = attr.foods ?? [];
    this.createdAt = attr.createdAt ?? new Date();
  }

}

export namespace Meal {
  export type Attributes = {
    id: string;
    accountId: string;
    status: Meal.StatusType;
    inputFileKey: string;
    inputType: Meal.InputType;
    timeZone?: string;
    attempts?: number;
    name?: string;
    icon?: string;
    foods?: Meal.FoodType[];
    createdAt?: Date;
  }

  export const StatusType = {
    UPLOADING: 'UPLOADING',
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
  };

  export type StatusType = ValueOf<typeof StatusType>;

  export const InputType = {
    PICTURE: 'PICTURE',
    AUDIO: 'AUDIO',
  };

  export type InputType = ValueOf<typeof InputType>;

  export const InputFile = {
    'audio/m4a': {
      extension: 'm4a',
      inputType: InputType.AUDIO,
    },
    'audio/webm': {
      extension: 'webm',
      inputType: InputType.AUDIO,
    },
    'image/jpeg': {
      extension: 'jpeg',
      inputType: InputType.PICTURE,
    },
  } as const;

  export type MimeType = keyof typeof InputFile;

  export const mimeTypes = Object.keys(InputFile) as [MimeType, ...MimeType[]];

  export function getInputFile(mimeType: MimeType) {
    return InputFile[mimeType];
  }

  export function getInputFileByKey(inputFileKey: string) {
    const extension = inputFileKey.split('.').pop()?.toLowerCase();
    const mimeType = mimeTypes.find(
      (type) => InputFile[type].extension === extension,
    );

    if (!mimeType) {
      throw new Error(`Unsupported input file extension: ${extension ?? 'none'}.`);
    }

    return {
      mimeType,
      ...InputFile[mimeType],
    };
  }

  export type FoodType = {
    name: string;
    quantity: string;
    calories: number;
    proteins: number;
    carbohydrates: number;
    fats: number;
  };

}
