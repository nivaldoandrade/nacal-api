import { Meal } from '@application/entities/Meal';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class CheckMealUploadUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealStorageGateway: MealFileStorageGateway,
  ) { }

  async execute({ accountId, mealId }: CheckMealUploadUseCase.Input): Promise<void> {
    const meal = await this.mealRepository.findById({
      accountId,
      mealId,
      consistentRead: true,
    });

    if (!meal || !CheckMealUploadUseCase.isStalled(meal)) {
      return;
    }

    const failure = await this.mealRepository.failAndRefund({ meal });

    if (failure.failed) {
      await this.mealStorageGateway.deleteInputFile(meal.inputFileKey);
    }
  }

  private static isStalled(meal: Meal): boolean {
    if (meal.status === Meal.StatusType.UPLOADING) {
      return true;
    }

    return meal.status === Meal.StatusType.QUEUED && meal.attempts === 0;
  }
}

export namespace CheckMealUploadUseCase {
  export type Input = {
    accountId: string;
    mealId: string;
  }
}
