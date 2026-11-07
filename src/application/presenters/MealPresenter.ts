import { Meal } from '@application/entities/Meal';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealPresenter {

  constructor(private readonly mealFileStorageGateway: MealFileStorageGateway) { }

  toOutput(meal: Meal): MealPresenter.Output {
    const { canAddItems, unidentified } = meal.getAddItemsState();
    const inputFileUrl = meal.inputFileKey
      && meal.status !== Meal.StatusType.REJECTED
      && meal.status !== Meal.StatusType.FAILED
      ? this.mealFileStorageGateway.getFileURL(meal.inputFileKey)
      : null;

    return {
      id: meal.id,
      name: meal.name,
      icon: meal.icon,
      status: meal.status,
      rejectionReason: meal.rejectionReason,
      foods: meal.foods,
      inputFileType: meal.inputType,
      inputFileUrl: inputFileUrl,
      canAddItems,
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
    inputFileUrl: string | null;
    name: string;
    icon: string;
    foods: Meal.FoodType[];
    canAddItems: boolean;
    unidentified: Meal.UnidentifiedKind | null;
    createdAt: Date;
  }
}
