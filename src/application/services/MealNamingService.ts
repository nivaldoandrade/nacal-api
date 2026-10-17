import { ValueOf } from '@shared/utils/ValueOf';

export class MealNamingService {

  static resolve(
    createdAt: Date,
    timeZone?: string,
    override?: MealNamingService.MealType | null,
  ): MealNamingService.Result {
    const mealType = override ?? this.resolveMealTypeByHour(createdAt, timeZone);

    return MealNamingService.MEAL_TYPE_METADATA[mealType];
  }

  static resolveMealTypeByHour(
    createdAt: Date,
    timeZone?: string,
  ): MealNamingService.MealType {
    const hour = this.getLocalHour(createdAt, timeZone);

    const entry = MealNamingService.HOUR_RANGES.find(
      ({ fromHour, toHour }) => hour >= fromHour && hour <= toHour,
    );

    return entry?.mealType ?? MealNamingService.MealType.SUPPER;
  }

  static isValidTimeZone(timeZone: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return true;
    } catch {
      return false;
    }
  }

  private static getLocalHour(date: Date, timeZone?: string): number {
    const safeTimeZone = timeZone && this.isValidTimeZone(timeZone)
      ? timeZone
      : MealNamingService.DEFAULT_TIME_ZONE;

    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTimeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date);

    return Number(hour);
  }
}

export namespace MealNamingService {
  export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

  export const MealType = {
    BREAKFAST: 'BREAKFAST',
    LUNCH: 'LUNCH',
    AFTERNOON_SNACK: 'AFTERNOON_SNACK',
    DINNER: 'DINNER',
    SUPPER: 'SUPPER',
  } as const;

  export type MealType = ValueOf<typeof MealType>;

  export const MEAL_TYPES: [MealType, ...MealType[]] = [
    MealType.BREAKFAST,
    MealType.LUNCH,
    MealType.AFTERNOON_SNACK,
    MealType.DINNER,
    MealType.SUPPER,
  ];

  export type Result = {
    name: string;
    icon: string;
  };

  export type HourRange = {
    fromHour: number;
    toHour: number;
    mealType: MealType;
  }

  export const MEAL_TYPE_METADATA: Record<MealType, Result> = {
    [MealType.BREAKFAST]: { name: 'Café da manhã', icon: '☕' },
    [MealType.LUNCH]: { name: 'Almoço', icon: '🍽️' },
    [MealType.AFTERNOON_SNACK]: { name: 'Lanche da tarde', icon: '🍎' },
    [MealType.DINNER]: { name: 'Jantar', icon: '🍲' },
    [MealType.SUPPER]: { name: 'Ceia', icon: '🌙' },
  } as const;

  export const HOUR_RANGES: HourRange[] = [
    { fromHour: 4, toHour: 10, mealType: MealType.BREAKFAST },
    { fromHour: 11, toHour: 14, mealType: MealType.LUNCH },
    { fromHour: 15, toHour: 17, mealType: MealType.AFTERNOON_SNACK },
    { fromHour: 18, toHour: 22, mealType: MealType.DINNER },
  ] as const;
}
