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

  private static readonly MAX_APPEND_ATTEMPTS = 3;

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealAiGateway: MealAiGateway,
    private readonly mealPresenter: MealPresenter,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly mealQuotaService: MealQuotaService,
  ) { }

  async execute({ accountId, mealId, text }: AddMealItemsUseCase.Input): Promise<AddMealItemsUseCase.Output> {
    const now = new Date();

    let meal = await this.findAddableMeal({ accountId, mealId, now });

    await this.ensureQuotaAvailable(accountId);

    const { foods, unidentifiedCount } = await this.mealAiGateway.extractFoodsFromText({
      mealId: meal.id,
      text,
      existingFoods: meal.foods,
    });

    for (let attempt = 1; attempt <= AddMealItemsUseCase.MAX_APPEND_ATTEMPTS; attempt++) {
      const remainingSlots = Meal.MAX_FOODS - meal.foods.length;
      const firstOrder = meal.nextFoodOrder();
      const newFoods: Meal.FoodType[] = foods
        .slice(0, remainingSlots)
        .map((food, index) => Meal.createFood(food, Meal.FoodSource.ADDED, firstOrder + index));

      if (newFoods.length === 0) {
        throw new NoFoodIdentified();
      }

      const updatedMeal = await this.mealRepository.appendFoods({
        meal,
        foods: newFoods,
        now,
      });

      if (updatedMeal) {
        return {
          meal: this.mealPresenter.toOutput(updatedMeal),
          addedFoods: newFoods,
          skippedFoodsCount: foods.length - newFoods.length,
          unidentifiedFoodsCount: unidentifiedCount,
        };
      }

      meal = await this.findAddableMeal({ accountId, mealId, now });
    }

    throw new Error(`Could not append foods to meal ${mealId} after concurrent edits.`);
  }

  private async findAddableMeal({
    accountId,
    mealId,
    now,
  }: AddMealItemsUseCase.FindAddableMealParams): Promise<Meal> {
    const meal = await this.mealRepository.findActiveById({
      accountId,
      mealId,
      consistentRead: true,
    });

    if (!meal) {
      throw new ResourceNotFound('Meal not found.');
    }

    if (!meal.isEditable(now)) {
      throw new MealNotEditable();
    }

    if (meal.hasReachedItemLimit()) {
      throw new MealItemLimitReached();
    }

    return meal;
  }

  private async ensureQuotaAvailable(accountId: string): Promise<void> {
    const subscription = await this.subscriptionRepository.findByAccountId(accountId);
    const plan = Subscription.resolveEffectivePlan(subscription);

    await this.mealQuotaService.ensureCanAddItems({ accountId, plan });
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

  export type FindAddableMealParams = {
    accountId: string;
    mealId: string;
    now: Date;
  }
}
