import { Meal } from '@application/entities/Meal';
import { MealNamingService } from '@application/services/MealNamingService';
import { MealAiGateway } from '@infra/ai/gateways/MealAiGateway';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ProcessMealUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealAiGateway: MealAiGateway,
  ) { }

  async execute({ accountId, mealId }: ProcessMealUseCase.Input): Promise<void> {
    const meal = await this.mealRepository.findById({
      accountId,
      mealId,
    });

    if (!meal) {
      throw new Error(`Meal ${mealId} not found.`);
    }

    if (meal.status === Meal.StatusType.UPLOADING) {
      throw new Error(`Meal ${mealId} is still uploading.`);
    }

    if (meal.status === Meal.StatusType.PROCESSING) {
      throw new Error(`Meal ${mealId} is being processed.`);
    }

    if (meal.status === Meal.StatusType.SUCCESS) {
      return;
    }

    try {
      meal.status = Meal.StatusType.PROCESSING;
      meal.attempts += 1;
      await this.mealRepository.save(meal);

      const {
        mealType,
        foods,
      } = await this.mealAiGateway.processMeal(meal);

      const { name, icon } = MealNamingService.resolve(
        meal.createdAt,
        meal.timeZone,
        mealType,
      );

      meal.status = Meal.StatusType.SUCCESS;
      meal.name = name;
      meal.icon = icon;
      meal.foods = foods.map(food => ({
        ...food,
        calories: Math.round((food.carbohydrates * 4) + (food.proteins * 4) + (food.fats * 9)),
      }));

      await this.mealRepository.save(meal);

    } catch (error) {
      meal.status = meal.attempts > Meal.MAX_ATTEMPS
        ? Meal.StatusType.QUEUED
        : Meal.StatusType.FAILED;

      await this.mealRepository.save(meal);

      throw error;
    }

  }
}

export namespace ProcessMealUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
  }

}
