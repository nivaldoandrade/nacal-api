import { Meal } from '@application/entities/Meal';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealPresenter {

  toOutput(meal: Meal): MealPresenter.Output {
    const { canAddItems, unidentified } = meal.getAddItemsState();

    return {
      id: meal.id,
      name: meal.name,
      icon: meal.icon,
      status: meal.status,
      rejectionReason: meal.rejectionReason,
      foods: meal.foods,
      inputFileType: meal.inputType,
      canAddItems,
      canRemoveItems: meal.canRemoveItems(),
      unidentified,
      createdAt: meal.createdAt,
    };
  }
}

export namespace MealPresenter {
  export type Output = {
    id: string;
    status: Meal.StatusType;
    rejectionReason: Meal.RejectionReason | null;
    inputFileType: Meal.InputType;
    name: string;
    icon: string;
    foods: Meal.FoodType[];
    canAddItems: boolean;
    canRemoveItems: boolean;
    unidentified: Meal.UnidentifiedKind | null;
    createdAt: Date;
  }
}
