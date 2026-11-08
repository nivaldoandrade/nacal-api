import { Meal } from '@application/entities/Meal';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealFoodsEditService {

  private static readonly MAX_ATTEMPTS = 3;

  constructor(private readonly mealRepository: MealRepository) { }

  async edit({ accountId, mealId, apply }: MealFoodsEditService.EditParams): Promise<Meal> {
    for (let attempt = 1; attempt <= MealFoodsEditService.MAX_ATTEMPTS; attempt++) {
      const meal = await this.mealRepository.findActiveById({
        accountId,
        mealId,
        consistentRead: true,
      });

      if (!meal) {
        throw new ResourceNotFound('Meal not found.');
      }

      const expectedVersion = meal.foodsVersion;
      const changed = apply(meal, new Date());

      if (!changed) {
        return meal;
      }

      const savedMeal = await this.mealRepository.saveFoods({ meal, expectedVersion });

      if (savedMeal) {
        return savedMeal;
      }
    }

    throw new Error(`Could not save foods of meal ${mealId} after concurrent edits.`);
  }
}

export namespace MealFoodsEditService {
  export type EditParams = {
    accountId: string;
    mealId: string;
    apply: (meal: Meal, now: Date) => boolean;
  }
}
