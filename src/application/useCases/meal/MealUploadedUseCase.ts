import { MealProcessingRepository } from '@infra/databases/dynamodb/MealProcessingRepository';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { MealQueueGateway } from '@infra/gateways/MealQueueGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { logger } from '@shared/logger/logger';

@Injectable()
export class MealUploadedUseCase {

  constructor(
    private readonly mealFileStorageGateway: MealFileStorageGateway,
    private readonly mealRepository: MealRepository,
    private readonly mealProcessingRepository: MealProcessingRepository,
    private readonly mealQueueGateway: MealQueueGateway,
  ) { }

  async execute({ fileKey }: MealUploadedUseCase.Input): Promise<void> {
    const { mealId, accountId } = await this.mealFileStorageGateway.getMetadata(fileKey);

    const meal = await this.mealRepository.findById({ mealId, accountId, consistentRead: true });

    if (!meal) {
      logger.warn('uploaded file has no meal', { fileKey, mealId, accountId });

      return;
    }

    if (meal.inputFileKey !== fileKey) {
      logger.warn('uploaded file does not match meal input file', {
        fileKey,
        mealId,
        accountId,
        inputFileKey: meal.inputFileKey,
      });

      return;
    }

    const queued = await this.mealProcessingRepository.markQueued({ accountId, mealId });

    if (!queued) {
      return;
    }

    await this.mealQueueGateway.publish({ accountId, mealId });
  }
}

export namespace MealUploadedUseCase {
  export type Input = {
    fileKey: string;
  }
}
