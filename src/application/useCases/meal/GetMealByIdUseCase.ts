import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { MealPresenter } from '@application/presenters/MealPresenter';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetMealByIdUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealPresenter: MealPresenter,
  ) { }

  async execute({ accountId, mealId }: GetMealByIdUseCase.Input): Promise<GetMealByIdUseCase.Output> {
    const meal = await this.mealRepository.findActiveById({
      accountId,
      mealId,
      consistentRead: true,
    });

    if (!meal) {
      throw new ResourceNotFound('Meal not found.');
    }

    return {
      meal: this.mealPresenter.toOutput(meal),
    };
  }
}

export namespace GetMealByIdUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
  }

  export type Output = {
    meal: MealPresenter.Output;
  }
}
