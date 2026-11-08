import { MealPresenter } from '@application/presenters/MealPresenter';
import { MealFoodsEditService } from '@application/services/MealFoodsEditService';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class RestoreMealItemUseCase {

  constructor(
    private readonly mealFoodsEditService: MealFoodsEditService,
    private readonly mealPresenter: MealPresenter,
  ) { }

  async execute({ accountId, mealId, itemId }: RestoreMealItemUseCase.Input): Promise<RestoreMealItemUseCase.Output> {
    const meal = await this.mealFoodsEditService.edit({
      accountId,
      mealId,
      apply: (currentMeal, now) => currentMeal.restoreFood(itemId, now),
    });

    return {
      meal: this.mealPresenter.toOutput(meal),
    };
  }
}

export namespace RestoreMealItemUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
    itemId: string;
  }

  export type Output = {
    meal: MealPresenter.Output;
  }
}
