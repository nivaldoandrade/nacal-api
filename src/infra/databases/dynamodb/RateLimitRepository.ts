
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';
import { getLocalDay } from '@shared/utils/timeZone';

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
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }

      console.error(error);
      throw error;
    }
  }

  async incrementQuotaCounter({
    scope,
    key,
    bucket,
    expiresAt,
    limit,
  }: RateLimitRepository.IncrementQuotaCounterParams): Promise<number | null> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Key: RateLimitRepository.getQuotaCounterKey({ scope, key, bucket }),
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
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }

      console.error(error);
      throw error;
    }
  }

  async decrementQuotaCounter(params: RateLimitRepository.QuotaCounterKeyParams): Promise<boolean> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      ...RateLimitRepository.buildQuotaCounterDecrement(params),
      ReturnValues: 'UPDATED_NEW',
    });

    try {
      await dynamodbClient.send(command);
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }

      throw error;
    }
  }

  async getQuotaCount({ scope, key, bucket }: RateLimitRepository.QuotaCounterKeyParams): Promise<number> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.rateLimitTable,
      Key: RateLimitRepository.getQuotaCounterKey({ scope, key, bucket }),
    });

    const { Item } = await dynamodbClient.send(command);
    return (Item?.count as number) ?? 0;
  }

  static getCalendarMonthBucket(now: Date = new Date()): RateLimitRepository.QuotaBucket {
    const bucket = now.toISOString().slice(0, 7);
    const startNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const expiresAt = Math.floor(startNextMonth / 1000) + 7 * 86_400;
    return { bucket, expiresAt };
  }

  static getCalendarDayBucket(now: Date, timeZone: string): RateLimitRepository.QuotaBucket {
    const bucket = getLocalDay(now, timeZone);
    const expiresAt = Math.floor(now.getTime() / 1000) + 15 * 86_400;
    return { bucket, expiresAt };
  }

  static getQuotaCounterKey({ scope, key, bucket }: RateLimitRepository.QuotaCounterKeyParams): RateLimitRepository.QuotaCounterKey {
    return {
      PK: `RL#${scope}#${key}`,
      SK: bucket,
    };
  }

  static buildQuotaCounterDecrement(params: RateLimitRepository.QuotaCounterKeyParams): RateLimitRepository.QuotaCounterDecrement {
    return {
      Key: RateLimitRepository.getQuotaCounterKey(params),
      UpdateExpression: 'ADD #count :dec',
      ConditionExpression: '#count > :zero',
      ExpressionAttributeNames: {
        '#count': 'count',
      },
      ExpressionAttributeValues: {
        ':dec': -1,
        ':zero': 0,
      },
    };
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

  export type QuotaScope = 'account-monthly' | 'account-daily';

  export type QuotaCounterKeyParams = {
    scope: QuotaScope;
    key: string;
    bucket: string;
  };

  export type IncrementQuotaCounterParams = QuotaCounterKeyParams & {
    expiresAt: number;
    limit?: number;
  };

  export type QuotaBucket = {
    bucket: string;
    expiresAt: number;
  };

  export type QuotaCounterKey = {
    PK: `RL#${string}#${string}`;
    SK: string;
  };

  export type QuotaCounterDecrement = {
    Key: QuotaCounterKey;
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, number>;
  };

  export type WebhookEventParams = {
    scope: 'webhook-event';
    key: string;
  };

  export const WEBHOOK_EVENT_SK = 'EVENT';
}

