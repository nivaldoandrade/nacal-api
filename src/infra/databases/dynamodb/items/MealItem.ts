import { Meal } from '@application/entities/Meal';

export class MealItem {
  static readonly TYPE: MealItem.Type = 'MEAL';

  private readonly keys: MealItem.Keys;

  constructor(private readonly attrs: MealItem.Attributes) {
    this.keys = {
      PK: MealItem.getPK({
        accountId: attrs.accountId,
        mealId: attrs.id,
      }),
      SK: MealItem.getSK(attrs.id),
      GSI1PK: MealItem.GSI1PK({
        accountId: attrs.accountId,
        createdAt: new Date(attrs.createdAt),
      }),
      GSI1SK: MealItem.GSI1SK(attrs.id),
    };
  }

  static fromEntity(meal: Meal): MealItem {
    return new MealItem({
      ...meal,
      createdAt: meal.createdAt.toISOString(),
      rejectedAt: meal.rejectedAt?.toISOString() ?? null,
      editedAt: meal.editedAt?.toISOString() ?? null,
    });
  }

  static toEntity(mealIdAttr: MealItem.Attributes): Meal {
    return new Meal({
      ...mealIdAttr,
      createdAt: new Date(mealIdAttr.createdAt),
      rejectedAt: mealIdAttr.rejectedAt ? new Date(mealIdAttr.rejectedAt) : null,
      editedAt: mealIdAttr.editedAt ? new Date(mealIdAttr.editedAt) : null,
    });
  }

  getItem(): MealItem.ItemType {
    return {
      ...this.keys,
      ...this.attrs,
      type: MealItem.TYPE,
    };
  }

  static getPK(
    { accountId, mealId }: MealItem.PKParams,
  ): MealItem.Keys['PK'] {
    return `ACCOUNT#${accountId}MEAL#${mealId}`;
  }

  static getSK(mealId: string): MealItem.Keys['SK'] {
    return `MEAL#${mealId}`;
  }

  static GSI1PK({ accountId, createdAt }: MealItem.GSI1PKParams): MealItem.Keys['GSI1PK'] {
    const year = createdAt.getUTCFullYear();
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
    const date = String(createdAt.getUTCDate()).padStart(2, '0');

    return `MEAL#${accountId}#${year}-${month}-${date}`;
  }

  static GSI1SK(mealId: string): MealItem.Keys['SK'] {
    return `MEAL#${mealId}`;
  }

}

export namespace MealItem {
  export type Type = 'MEAL';

  export type GSI1PKParams = {
    accountId: string;
    createdAt: Date;
  }

  export type PKParams = {
    accountId: string;
    mealId: string;
  }

  export type Keys = {
    PK: `ACCOUNT#${string}MEAL#${string}`;
    SK: `MEAL#${string}`;
    GSI1PK: `MEAL#${string}#${string}-${string}-${string}`;
    GSI1SK: `MEAL#${string}`;
  }

  export type Attributes = {
    id: string;
    accountId: string;
    status: Meal.StatusType;
    inputFileKey: string;
    inputType: Meal.InputType;
    timeZone?: string;
    description?: string | null;
    attempts?: number;
    name: string;
    icon?: string;
    foods?: Meal.FoodType[];
    rejectionReason?: Meal.RejectionReason | null;
    gateScore?: number | null;
    quotaMonth?: string | null;
    quotaRefunded?: boolean;
    leaseExpiresAt?: number | null;
    itemAdditions?: number;
    unidentified?: Meal.UnidentifiedKind | null;
    createdAt: string;
    rejectedAt?: string | null;
    editedAt?: string | null;
  }

  export type ItemType = Keys & Attributes & {
    type: Type;
  }

}
