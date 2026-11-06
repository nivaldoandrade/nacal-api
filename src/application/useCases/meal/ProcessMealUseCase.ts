import { Meal } from '@application/entities/Meal';
import { MealRejectedError } from '@application/errors/MealRejectedError';
import { MealFileValidationService } from '@application/services/MealFileValidationService';
import { MealNamingService } from '@application/services/MealNamingService';
import { MealAiGateway } from '@infra/ai/gateways/MealAiGateway';
import { MealGateGateway } from '@infra/ai/gateways/MealGateGateway';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ProcessMealUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealStorageGateway: MealFileStorageGateway,
    private readonly mealAiGateway: MealAiGateway,
    private readonly mealFileValidationService: MealFileValidationService,
    private readonly mealGateGateway: MealGateGateway,
  ) { }

  async execute({ accountId, mealId }: ProcessMealUseCase.Input): Promise<void> {
    const meal = await this.mealRepository.findById({
      accountId,
      mealId,
    });

    if (!meal) {
      throw new Error(`Meal ${mealId} not found.`);
    }

    if (ProcessMealUseCase.isTerminal(meal.status)) {
      return;
    }

    if (meal.status === Meal.StatusType.UPLOADING) {
      throw new Error(`Meal ${mealId} is still uploading.`);
    }

    const now = Math.floor(Date.now() / 1000);
    const claimedMeal = await this.mealRepository.claimForProcessing({
      accountId,
      mealId,
      now,
      leaseExpiresAt: now + Meal.PROCESSING_LEASE_SECONDS,
    });

    if (!claimedMeal) {
      await this.markFailedIfExhausted({ accountId, mealId, now });
      return;
    }

    try {
      const inputFile = await this.mealStorageGateway.getObjectBytes(claimedMeal.inputFileKey);
      const validation = await this.mealFileValidationService.validate({
        meal: claimedMeal,
        file: inputFile,
      });

      let gateScore: number | null = null;

      if (claimedMeal.inputType === Meal.InputType.PICTURE) {
        if (!('width' in validation)) {
          throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
        }

        const gateResult = await this.mealGateGateway.evaluateImage({
          mealId: claimedMeal.id,
          image: inputFile,
          width: validation.width,
          height: validation.height,
        });

        gateScore = gateResult.score ?? null;

        if (gateResult.decision === 'REJECT') {
          throw new MealRejectedError(
            Meal.RejectionReason.NOT_A_MEAL,
            gateResult.score,
          );
        }
      }

      const {
        mealType,
        foods,
        unidentified,
      } = await this.mealAiGateway.processMeal(claimedMeal);

      if (foods.length === 0) {
        throw new MealRejectedError(
          Meal.RejectionReason.NO_FOOD_DETECTED,
          gateScore ?? undefined,
        );
      }

      const { name, icon } = MealNamingService.resolve(
        claimedMeal.createdAt,
        claimedMeal.timeZone,
        mealType,
      );

      claimedMeal.name = name;
      claimedMeal.icon = icon;
      claimedMeal.foods = foods.map(food => ({
        ...food,
        calories: Meal.computeCalories(food),
        source: Meal.FoodSource.INITIAL,
      }));
      claimedMeal.unidentified = unidentified;

      const markedAsSuccess = await this.mealRepository.markSuccess({
        meal: claimedMeal,
        gateScore,
      });

      if (!markedAsSuccess) {
        const currentMeal = await this.mealRepository.findById({ accountId, mealId });

        if (currentMeal && ProcessMealUseCase.isTerminal(currentMeal.status)) {
          return;
        }

        throw new Error(`Meal ${mealId} could not be marked as success.`);
      }
    } catch (error) {
      if (error instanceof MealRejectedError) {
        const rejection = await this.mealRepository.rejectAndRefund({
          meal: claimedMeal,
          reason: error.reason,
          gateScore: error.gateScore,
        });

        if (rejection.rejected) {
          await this.deleteInputFile(claimedMeal.inputFileKey);
        }

        return;
      }

      const retryable = await this.handleFailure(claimedMeal);

      if (retryable) {
        throw error;
      }
    }
  }

  private async handleFailure(meal: Meal): Promise<boolean> {
    if (meal.attempts >= Meal.MAX_ATTEMPTS) {
      const failure = await this.mealRepository.failAndRefund({ meal });

      if (failure.failed) {
        await this.deleteInputFile(meal.inputFileKey);
      }

      return false;
    }

    if (meal.leaseExpiresAt === null) {
      throw new Error(`Meal ${meal.id} has no processing lease.`);
    }

    return this.mealRepository.markForRetry({
      accountId: meal.accountId,
      mealId: meal.id,
      leaseExpiresAt: meal.leaseExpiresAt,
    });
  }

  private async markFailedIfExhausted({
    accountId,
    mealId,
    now,
  }: ProcessMealUseCase.MarkFailedIfExhaustedParams): Promise<void> {
    const meal = await this.mealRepository.findById({ accountId, mealId });

    if (!meal) {
      return;
    }

    if (ProcessMealUseCase.isTerminal(meal.status)) {
      return;
    }

    if (meal.status === Meal.StatusType.UPLOADING) {
      return;
    }

    if (meal.attempts < Meal.MAX_ATTEMPTS) {
      return;
    }

    if (!ProcessMealUseCase.canBeFailed(meal, now)) {
      return;
    }

    const failure = await this.mealRepository.failAndRefund({ meal });

    if (failure.failed) {
      await this.deleteInputFile(meal.inputFileKey);
    }
  }

  private async deleteInputFile(inputFileKey: string): Promise<void> {
    try {
      await this.mealStorageGateway.deleteObject(inputFileKey);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to delete meal input file:', error);
    }
  }

  private static canBeFailed(meal: Meal, now: number): boolean {
    if (meal.status === Meal.StatusType.QUEUED) {
      return true;
    }

    if (meal.status !== Meal.StatusType.PROCESSING) {
      return false;
    }

    return meal.leaseExpiresAt === null || meal.leaseExpiresAt < now;
  }

  private static isTerminal(status: Meal.StatusType): boolean {
    return status === Meal.StatusType.SUCCESS
      || status === Meal.StatusType.REJECTED
      || status === Meal.StatusType.FAILED;
  }
}

export namespace ProcessMealUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
  }

  export type MarkFailedIfExhaustedParams = Input & {
    now: number;
  }

}
