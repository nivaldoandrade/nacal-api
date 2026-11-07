import { Meal } from '@application/entities/Meal';
import { Subscription } from '@application/entities/Subscription';
import { MealItemLimitReached } from '@application/errors/application/MealItemLimitReached';
import { MealNotEditable } from '@application/errors/application/MealNotEditable';
import { NoFoodIdentified } from '@application/errors/application/NoFoodIdentified';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { MealPresenter } from '@application/presenters/MealPresenter';
import { MealQuotaService } from '@application/services/MealQuotaService';
import { MealAiGateway } from '@infra/ai/gateways/MealAiGateway';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class AddMealItemsUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealAiGateway: MealAiGateway,
    private readonly mealPresenter: MealPresenter,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly mealQuotaService: MealQuotaService,
  ) { }

  async execute({ accountId, mealId, text }: AddMealItemsUseCase.Input): Promise<AddMealItemsUseCase.Output> {
    const meal = await this.mealRepository.findById({ accountId, mealId });

    if (!meal) {
      throw new ResourceNotFound('Meal not found.');
    }

    const now = new Date();

    if (!meal.isEditable(now)) {
      throw new MealNotEditable();
    }

    if (meal.hasReachedItemLimit()) {
      throw new MealItemLimitReached();
    }

    await this.ensureQuotaAvailable(accountId);

    const { foods, unidentifiedCount } = await this.mealAiGateway.extractFoodsFromText({
      mealId: meal.id,
      text,
      existingFoods: meal.foods,
    });

    const remainingSlots = Meal.MAX_FOODS - meal.foods.length;
    const newFoods: Meal.FoodType[] = foods
      .slice(0, remainingSlots)
      .map((food) => ({
        ...food,
        calories: Meal.computeCalories(food),
        source: Meal.FoodSource.ADDED,
      }));

    if (newFoods.length === 0) {
      throw new NoFoodIdentified();
    }

    const updatedMeal = await this.mealRepository.appendFoods({
      meal,
      foods: newFoods,
      now,
    });

    if (!updatedMeal) {
      throw await this.resolveAppendFailure({ accountId, mealId, now });
    }

    return {
      meal: this.mealPresenter.toOutput(updatedMeal),
      addedFoods: newFoods,
      skippedFoodsCount: foods.length - newFoods.length,
      unidentifiedFoodsCount: unidentifiedCount,
    };
  }

  private async ensureQuotaAvailable(accountId: string): Promise<void> {
    const subscription = await this.subscriptionRepository.findByAccountId(accountId);
    const plan = Subscription.resolveEffectivePlan(subscription);

    await this.mealQuotaService.ensureAvailable({ accountId, plan });
  }

  private async resolveAppendFailure({
    accountId,
    mealId,
    now,
  }: AddMealItemsUseCase.ResolveAppendFailureParams): Promise<Error> {
    const currentMeal = await this.mealRepository.findById({ accountId, mealId });

    if (!currentMeal) {
      return new ResourceNotFound('Meal not found.');
    }

    if (!currentMeal.isEditable(now)) {
      return new MealNotEditable();
    }

    return new MealItemLimitReached();
  }
}

export namespace AddMealItemsUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
    text: string;
  }

  export type Output = {
    meal: MealPresenter.Output;
    addedFoods: Meal.FoodType[];
    skippedFoodsCount: number;
    unidentifiedFoodsCount: number;
  }

  export type ResolveAppendFailureParams = {
    accountId: string;
    mealId: string;
    now: Date;
  }
}
