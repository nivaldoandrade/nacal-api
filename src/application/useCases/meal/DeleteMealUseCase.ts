import { MealNotEditable } from '@application/errors/application/MealNotEditable';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class DeleteMealUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealFileStorageGateway: MealFileStorageGateway,
  ) { }

  async execute({ accountId, mealId }: DeleteMealUseCase.Input): Promise<void> {
    const meal = await this.mealRepository.findActiveById({ accountId, mealId });

    if (!meal) {
      throw new ResourceNotFound('Meal not found.');
    }

    if (!meal.isDeletable()) {
      throw new MealNotEditable();
    }

    const deleted = await this.mealRepository.markDeleted({ meal, now: new Date() });

    if (!deleted) {
      const currentMeal = await this.mealRepository.findActiveById({ accountId, mealId });

      if (!currentMeal) {
        throw new ResourceNotFound('Meal not found.');
      }

      throw new MealNotEditable();
    }

    if (!meal.inputFileKey) {
      return;
    }

    try {
      await this.mealFileStorageGateway.deleteObject(meal.inputFileKey);
    } catch (error) {
      console.error(`Failed to delete input file of meal ${meal.id}:`, error);
    }
  }
}

export namespace DeleteMealUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
  }
}
