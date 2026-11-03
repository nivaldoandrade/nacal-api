import { Meal } from '@application/entities/Meal';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetMealByIdUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealFileStorageGateway: MealFileStorageGateway,
  ) { }

  async execute({ accountId, mealId }: GetMealByIdUseCase.Input): Promise<GetMealByIdUseCase.Output> {
    const meal = await this.mealRepository.findById({ accountId, mealId });

    if (!meal) {
      throw new ResourceNotFound('Meal not found.');
    }

    const inputFileUrl = meal.status === Meal.StatusType.REJECTED || meal.status === Meal.StatusType.FAILED
      ? null
      : this.mealFileStorageGateway.getFileURL(meal.inputFileKey);

    return {
      meal: {
        id: meal.id,
        name: meal.name,
        icon: meal.icon,
        status: meal.status,
        rejectionReason: meal.rejectionReason,
        foods: meal.foods,
        inputFileType: meal.inputType,
        inputFileUrl: inputFileUrl,
        createdAt: meal.createdAt,
      },
    };
  }
}

namespace GetMealByIdUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
  }

  export type Output = {
    meal: {
      id: string;
      status: Meal.StatusType;
      rejectionReason: Meal.RejectionReason | null;
      inputFileType: Meal.InputType;
      inputFileUrl: string | null;
      name: string;
      icon: string;
      foods: Meal.FoodType[];
      createdAt: Date;
    }
  }
}
