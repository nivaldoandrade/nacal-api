import { Meal } from '@application/entities/Meal';
import { Subscription } from '@application/entities/Subscription';
import { NoFoodIdentified } from '@application/errors/application/NoFoodIdentified';
import { MealPresenter } from '@application/presenters/MealPresenter';
import { MealNamingService } from '@application/services/MealNamingService';
import { MealQuotaService } from '@application/services/MealQuotaService';
import { MealAiGateway } from '@infra/ai/gateways/MealAiGateway';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { Injectable } from '@kernel/decorators/Injectable';
import { generateUniqueId } from '@shared/utils/generateUniqueId';

@Injectable()
export class CreateTextMealUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealAiGateway: MealAiGateway,
    private readonly mealPresenter: MealPresenter,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly mealQuotaService: MealQuotaService,
  ) { }

  async execute({ accountId, timeZone, text }: CreateTextMealUseCase.Input): Promise<CreateTextMealUseCase.Output> {
    const subscription = await this.subscriptionRepository.findByAccountId(accountId);
    const plan = Subscription.resolveEffectivePlan(subscription);

    await this.mealQuotaService.ensureAvailable({ accountId, plan });

    const mealId = generateUniqueId();
    const createdAt = new Date();

    const { mealType, foods, unidentifiedCount } = await this.mealAiGateway.extractMealFromText({
      mealId,
      text,
    });

    const mealFoods: Meal.FoodType[] = foods
      .slice(0, Meal.MAX_FOODS)
      .map((food) => ({
        ...food,
        calories: Meal.computeCalories(food),
        source: Meal.FoodSource.INITIAL,
      }));

    if (mealFoods.length === 0) {
      throw new NoFoodIdentified();
    }

    const { quotaMonth } = await this.mealQuotaService.consume({ accountId, plan });

    const meal = new Meal({
      id: mealId,
      accountId,
      status: Meal.StatusType.SUCCESS,
      inputType: Meal.InputType.TEXT,
      inputFileKey: null,
      timeZone,
      description: text,
      foods: mealFoods,
      quotaMonth,
      createdAt,
    });

    const { name, icon } = MealNamingService.resolve(meal.createdAt, meal.timeZone, mealType);

    meal.name = name;
    meal.icon = icon;

    try {
      await this.mealRepository.create(meal);
    } catch (error) {
      await this.refundQuota({ accountId, quotaMonth, error });

      throw error;
    }

    return {
      meal: this.mealPresenter.toOutput(meal),
      unidentifiedFoodsCount: unidentifiedCount,
    };
  }

  private async refundQuota({
    accountId,
    quotaMonth,
    error,
  }: CreateTextMealUseCase.RefundQuotaParams): Promise<void> {
    try {
      await this.mealQuotaService.refund({ accountId, quotaMonth });
    } catch (refundError) {
      throw new AggregateError(
        [error, refundError],
        `Failed to create text meal and refund meal quota for account ${accountId}.`,
        { cause: refundError },
      );
    }
  }
}

export namespace CreateTextMealUseCase {
  export type Input = {
    accountId: string;
    timeZone?: string;
    text: string;
  }

  export type Output = {
    meal: MealPresenter.Output;
    unidentifiedFoodsCount: number;
  }

  export type RefundQuotaParams = {
    accountId: string;
    quotaMonth: string;
    error: unknown;
  }
}
