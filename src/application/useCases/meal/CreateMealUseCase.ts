import { Meal } from '@application/entities/Meal';
import { Subscription } from '@application/entities/Subscription';
import { MealQuotaService } from '@application/services/MealQuotaService';
import { MealRepository } from '@infra/databases/dynamodb/MealRepository';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { generateUniqueId } from '@shared/utils/generateUniqueId';

@Injectable()
export class CreateMealUseCase {

  constructor(
    private readonly mealRepository: MealRepository,
    private readonly mealStorageGateway: MealFileStorageGateway,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly mealQuotaService: MealQuotaService,
  ) { }

  async execute({ accountId, timeZone, file }: CreateMealUseCase.Input): Promise<CreateMealUseCase.Output> {
    const subscription = await this.subscriptionRepository.findByAccountId(accountId);
    const plan = Subscription.resolveEffectivePlan(subscription);

    const { quotaMonth } = await this.mealQuotaService.consume({ accountId, plan });

    try {
      const mealId = generateUniqueId();

      const inputFileKey = MealFileStorageGateway.generateInputFileKey({
        accountId,
        mimeType: file.mimeType,
      });

      const meal = new Meal({
        id: mealId,
        accountId,
        inputType: file.inputType,
        inputFileKey: inputFileKey,
        timeZone,
        status: Meal.StatusType.UPLOADING,
        quotaMonth,
      });

      const { uploadSignature } = await this.mealStorageGateway.getPOST({
        accountId,
        mealId,
        inputFileKey,
        mimeType: file.mimeType,
        fileSize: file.size,
      });

      await this.mealRepository.create(meal);

      return {
        mealId,
        uploadSignature,
      };
    } catch (error) {
      try {
        await this.mealQuotaService.refund({ accountId, quotaMonth });
      } catch (refundError) {
        // eslint-disable-next-line no-console
        console.error(`Failed to refund meal quota for account ${accountId}:`, refundError);
      }

      throw error;
    }
  }
}

export namespace CreateMealUseCase {
  export type Input = {
    accountId: string;
    timeZone?: string;
    file: {
      inputType: Meal.InputType;
      mimeType: Meal.MimeType;
      size: number;
    }
  }

  export type Output = {
    mealId: string;
    uploadSignature: string;
  }
}
