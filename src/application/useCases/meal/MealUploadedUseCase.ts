import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { MealQueueGateway } from '@infra/gateways/MealQueueGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealUploadedUseCase {

  constructor(
    private readonly mealFileStorageGateway: MealFileStorageGateway,
    private readonly mealRepository: MealRepository,
    private readonly mealQueueGateway: MealQueueGateway,
  ) { }

  async execute({ fileKey }: MealUploadedUseCase.Input): Promise<void> {
    const { mealId, accountId } = await this.mealFileStorageGateway.getMetadata(fileKey);

    const meal = await this.mealRepository.findById({ mealId, accountId });

    if (!meal) {
      throw new ResourceNotFound('Meal not found.');
    }

    const queued = await this.mealRepository.markQueued({ accountId, mealId });

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
