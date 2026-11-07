import { ValueOf } from '@shared/utils/ValueOf';

export class Meal {
  // Must stay below the MealsQueue maxReceiveCount (3) so one delivery remains for cleanup.
  public static readonly MAX_ATTEMPTS: number = 2;

  // Must stay above the processMeal timeout (120s) and below the SQS visibility timeout (180s).
  public static readonly PROCESSING_LEASE_SECONDS: number = 130;

  public static readonly MAX_ITEM_ADDITIONS: number = 5;

  public static readonly MAX_FOODS: number = 30;

  public static readonly EDIT_WINDOW_HOURS: number = 24;

  readonly id: string;

  readonly accountId: string;

  status: Meal.StatusType;

  readonly inputFileKey: string | null;

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

  itemAdditions: number;

  unidentified: Meal.UnidentifiedKind | null;

  readonly createdAt: Date;

  rejectedAt: Date | null;

  editedAt: Date | null;

  constructor(attr: Meal.Attributes) {
    this.id = attr.id;
    this.accountId = attr.accountId;
    this.status = attr.status;
    this.inputFileKey = attr.inputFileKey ?? null;
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
    this.itemAdditions = attr.itemAdditions ?? 0;
    this.unidentified = attr.unidentified ?? null;
    this.createdAt = attr.createdAt ?? new Date();
    this.rejectedAt = attr.rejectedAt ?? null;
    this.editedAt = attr.editedAt ?? null;
  }

  requireInputFileKey(): string {
    if (!this.inputFileKey) {
      throw new Error(`Meal ${this.id} has no input file.`);
    }

    return this.inputFileKey;
  }

  isEditable(now: Date = new Date()): boolean {
    if (this.status !== Meal.StatusType.SUCCESS) {
      return false;
    }

    const editWindowMs = Meal.EDIT_WINDOW_HOURS * 60 * 60 * 1000;

    return now.getTime() - this.createdAt.getTime() <= editWindowMs;
  }

  hasReachedItemLimit(): boolean {
    return this.itemAdditions >= Meal.MAX_ITEM_ADDITIONS
      || this.foods.length >= Meal.MAX_FOODS;
  }

  canAddItems(now: Date = new Date()): boolean {
    return this.isEditable(now) && !this.hasReachedItemLimit();
  }

  getAddItemsState(now: Date = new Date()): Meal.AddItemsState {
    const canAddItems = this.canAddItems(now);

    return {
      canAddItems,
      unidentified: canAddItems && this.itemAdditions === 0 ? this.unidentified : null,
    };
  }

}

export namespace Meal {
  export type Attributes = {
    id: string;
    accountId: string;
    status: Meal.StatusType;
    inputFileKey?: string | null;
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
    itemAdditions?: number;
    unidentified?: Meal.UnidentifiedKind | null;
    createdAt?: Date;
    rejectedAt?: Date | null;
    editedAt?: Date | null;
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
    TEXT: 'TEXT',
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

  export const FoodSource = {
    INITIAL: 'INITIAL',
    ADDED: 'ADDED',
  } as const;

  export type FoodSource = ValueOf<typeof FoodSource>;

  export const UnidentifiedKind = {
    DRINK: 'DRINK',
    PACKAGED: 'PACKAGED',
    COVERED: 'COVERED',
    OTHER: 'OTHER',
  } as const;

  export type UnidentifiedKind = ValueOf<typeof UnidentifiedKind>;

  export type AddItemsState = {
    canAddItems: boolean;
    unidentified: UnidentifiedKind | null;
  };

  export const unidentifiedKinds = Object.values(UnidentifiedKind) as [UnidentifiedKind, ...UnidentifiedKind[]];

  export type FoodType = {
    name: string;
    quantity: string;
    calories: number;
    proteins: number;
    carbohydrates: number;
    fats: number;
    source?: FoodSource;
  };

  export type FoodMacros = Pick<FoodType, 'carbohydrates' | 'proteins' | 'fats'>;

  export function computeCalories({ carbohydrates, proteins, fats }: FoodMacros): number {
    return Math.round((carbohydrates * 4) + (proteins * 4) + (fats * 9));
  }

}
