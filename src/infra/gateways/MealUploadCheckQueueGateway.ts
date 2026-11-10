import { Meal } from '@application/entities/Meal';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsClient } from '@infra/clients/sqsClient';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class MealUploadCheckQueueGateway {

  constructor(
    private readonly config: AppConfig,
  ) { }

  async publish({
    accountId,
    mealId,
  }: MealUploadCheckQueueGateway.Message): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.config.queue.mealUploadCheckQueueUrl,
      MessageBody: JSON.stringify({ accountId, mealId }),
      DelaySeconds: Meal.UPLOAD_CHECK_DELAY_SECONDS,
    });

    await sqsClient.send(command);
  }
}

export namespace MealUploadCheckQueueGateway {
  export type Message = {
    accountId: string;
    mealId: string;
  }
}
