import { ISQSHandler } from '@application/contracts/ISQSHandler';
import { CheckMealUploadUseCase } from '@application/useCases/meal/CheckMealUploadUseCase';
import { MealUploadCheckQueueGateway } from '@infra/gateways/MealUploadCheckQueueGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealUploadCheckQueueConsumer implements ISQSHandler<MealUploadCheckQueueGateway.Message> {

  constructor(
    private readonly checkMealUploadUseCase: CheckMealUploadUseCase,
  ) { }

  async handle({
    accountId,
    mealId,
  }: MealUploadCheckQueueGateway.Message): Promise<void> {
    await this.checkMealUploadUseCase.execute({ accountId, mealId });
  }

}
