
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class RateLimitRepository {

  constructor(private readonly config: AppConfig) { }

  async increment({
    scope,
    key,
    windowSeconds,
    limit,
  }: RateLimitRepository.IncrementParams): Promise<number | null> {
    const now = Math.floor(Date.now() / 1000);
    const bucketStart = Math.floor(now / windowSeconds) * windowSeconds;

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Key: {
        PK: `RL#${scope}#${key}`,
        SK: String(bucketStart),
      },
      UpdateExpression: 'ADD #count :inc SET #expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':inc': 1,
        ':expiresAt': bucketStart + windowSeconds,
        ':max': limit,
      },
      ReturnValues: 'UPDATED_NEW',
    });

    try {
      const { Attributes } = await dynamodbClient.send(command);

      return (Attributes?.count as number) ?? null;
    } catch (error) {
      console.error(error);
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }

      throw error;
    }
  }

  async incrementCalendarMonth({ scope, key, limit }: RateLimitRepository.CalendarMonthParams): Promise<number | null> {
    const { bucket, expiresAt } = this.getCalendarMonthBucket();

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Key: {
        PK: `RL#${scope}#${key}`,
        SK: bucket,
      },
      UpdateExpression: 'ADD #count :inc SET #expiresAt = :expiresAt',
      ...(limit !== undefined && {
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
      }),
      ExpressionAttributeNames: {
        '#count': 'count',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':inc': 1,
        ':expiresAt': expiresAt,
        ...(limit !== undefined && { ':max': limit }),
      },
      ReturnValues: 'UPDATED_NEW',
    });

    try {
      const { Attributes } = await dynamodbClient.send(command);
      return (Attributes?.count as number) ?? null;
    } catch (error) {
      console.error(error);
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }

      throw error;
    }
  }

  async getCountCalendarMonth({ scope, key }: RateLimitRepository.CalendarMonthParams): Promise<number> {
    const { bucket } = this.getCalendarMonthBucket();

    const command = new GetCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Key: {
        PK: `RL#${scope}#${key}`,
        SK: bucket,
      },
    });

    const { Item } = await dynamodbClient.send(command);
    return (Item?.count as number) ?? 0;
  }

  private getCalendarMonthBucket(): { bucket: string; expiresAt: number } {
    const now = new Date();
    const bucket = now.toISOString().slice(0, 7);
    const startNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const expiresAt = Math.floor(startNextMonth / 1000) + 7 * 86_400;
    return { bucket, expiresAt };
  }

  async hasWebhookEvent({ scope, key }: RateLimitRepository.WebhookEventParams): Promise<boolean> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Key: {
        PK: `RL#${scope}#${key}`,
        SK: RateLimitRepository.WEBHOOK_EVENT_SK,
      },
    });

    const { Item } = await dynamodbClient.send(command);
    return Boolean(Item);
  }

  async markWebhookEvent({ scope, key }: RateLimitRepository.WebhookEventParams): Promise<void> {
    const expiresAt = Math.floor(Date.now() / 1000) + 14 * 86_400;

    const command = new PutCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Item: {
        PK: `RL#${scope}#${key}`,
        SK: RateLimitRepository.WEBHOOK_EVENT_SK,
        expiresAt,
      },
    });

    await dynamodbClient.send(command);
  }

}

export namespace RateLimitRepository {
  export type IncrementParams = {
    scope: 'ip' | 'account' | 'email';
    key: string;
    windowSeconds: number;
    limit: number;
  }

  export type CalendarMonthParams = {
    scope: 'account-monthly';
    key: string;
    limit?: number;
  };

  export type WebhookEventParams = {
    scope: 'webhook-event';
    key: string;
  };

  export const WEBHOOK_EVENT_SK = 'EVENT';
}

