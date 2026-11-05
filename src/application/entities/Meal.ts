import { ValueOf } from '@shared/utils/ValueOf';

export class Meal {
  // Must stay below the MealsQueue maxReceiveCount (3) so one delivery remains for cleanup.
  public static readonly MAX_ATTEMPTS: number = 2;

  // Must stay above the processMeal timeout (120s) and below the SQS visibility timeout (180s).
  public static readonly PROCESSING_LEASE_SECONDS: number = 130;

  readonly id: string;

  readonly accountId: string;

  status: Meal.StatusType;

  readonly inputFileKey: string;

  readonly inputType: Meal.InputType;

  readonly timeZone: string;

  readonly description: string | null;

  name: string;

  attempts: number;

  icon: string;

  foods: Meal.FoodType[];

  rejectionReason: Meal.RejectionReason | null;

  gateScore: number | null;

  quotaMonth: string | null;

  quotaRefunded: boolean;

  leaseExpiresAt: number | null;

  readonly createdAt: Date;

  rejectedAt: Date | null;

  constructor(attr: Meal.Attributes) {
    this.id = attr.id;
    this.accountId = attr.accountId;
    this.status = attr.status;
    this.inputFileKey = attr.inputFileKey;
    this.inputType = attr.inputType;
    this.timeZone = attr.timeZone ?? '';
    this.description = attr.description ?? null;
    this.attempts = attr.attempts ?? 0;
    this.name = attr.name ?? '';
    this.icon = attr.icon ?? '';
    this.foods = attr.foods ?? [];
    this.rejectionReason = attr.rejectionReason ?? null;
    this.gateScore = attr.gateScore ?? null;
    this.quotaMonth = attr.quotaMonth ?? null;
    this.quotaRefunded = attr.quotaRefunded ?? false;
    this.leaseExpiresAt = attr.leaseExpiresAt ?? null;
    this.createdAt = attr.createdAt ?? new Date();
    this.rejectedAt = attr.rejectedAt ?? null;
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
    description?: string | null;
    attempts?: number;
    name?: string;
    icon?: string;
    foods?: Meal.FoodType[];
    rejectionReason?: Meal.RejectionReason | null;
    gateScore?: number | null;
    quotaMonth?: string | null;
    quotaRefunded?: boolean;
    leaseExpiresAt?: number | null;
    createdAt?: Date;
    rejectedAt?: Date | null;
  }

  export const StatusType = {
    UPLOADING: 'UPLOADING',
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
    SUCCESS: 'SUCCESS',
    REJECTED: 'REJECTED',
    FAILED: 'FAILED',
  };

  export type StatusType = ValueOf<typeof StatusType>;

  export const RejectionReason = {
    NOT_A_MEAL: 'NOT_A_MEAL',
    NO_FOOD_DETECTED: 'NO_FOOD_DETECTED',
    INVALID_FILE: 'INVALID_FILE',
  };

  export type RejectionReason = ValueOf<typeof RejectionReason>;

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
