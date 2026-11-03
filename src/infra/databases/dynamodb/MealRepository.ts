import { Meal } from '@application/entities/Meal';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { MealItem } from '@infra/databases/dynamodb/items/MealItem';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class MealRepository {

  constructor(private readonly config: AppConfig) { }

  async markQueued({ accountId, mealId }: MealRepository.FindByIdParams): Promise<boolean> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealRepository.getKey({ accountId, mealId }),
      UpdateExpression: 'SET #status = :queued REMOVE #leaseExpiresAt',
      ConditionExpression: '#status = :uploading OR #status = :queued',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#leaseExpiresAt': 'leaseExpiresAt',
      },
      ExpressionAttributeValues: {
        ':queued': Meal.StatusType.QUEUED,
        ':uploading': Meal.StatusType.UPLOADING,
      },
      ReturnValues: 'NONE',
    });

    return this.sendConditional(command);
  }

  async markForRetry({
    accountId,
    mealId,
    leaseExpiresAt,
  }: MealRepository.MarkForRetryParams): Promise<boolean> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealRepository.getKey({ accountId, mealId }),
      UpdateExpression: 'SET #status = :queued REMOVE #leaseExpiresAt',
      ConditionExpression: '#status = :processing AND #leaseExpiresAt = :lease',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#leaseExpiresAt': 'leaseExpiresAt',
      },
      ExpressionAttributeValues: {
        ':queued': Meal.StatusType.QUEUED,
        ':processing': Meal.StatusType.PROCESSING,
        ':lease': leaseExpiresAt,
      },
      ReturnValues: 'NONE',
    });

    return this.sendConditional(command);
  }

  async claimForProcessing({
    accountId,
    mealId,
    leaseExpiresAt,
    now,
  }: MealRepository.ClaimForProcessingParams): Promise<Meal | null> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealRepository.getKey({ accountId, mealId }),
      UpdateExpression: 'SET #status = :processing, #leaseExpiresAt = :lease ADD #attempts :one',
      ConditionExpression: [
        '(#status = :queued OR (#status = :processing AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt < :now)))',
        '(attribute_not_exists(#attempts) OR #attempts < :max)',
      ].join(' AND '),
      ExpressionAttributeNames: {
        '#status': 'status',
        '#attempts': 'attempts',
        '#leaseExpiresAt': 'leaseExpiresAt',
      },
      ExpressionAttributeValues: {
        ':queued': Meal.StatusType.QUEUED,
        ':processing': Meal.StatusType.PROCESSING,
        ':lease': leaseExpiresAt,
        ':now': now,
        ':one': 1,
        ':max': Meal.MAX_ATTEMPTS,
      },
      ReturnValues: 'ALL_NEW',
    });

    try {
      const { Attributes } = await dynamodbClient.send(command);

      if (!Attributes) {
        return null;
      }

      return MealItem.toEntity(Attributes as MealItem.ItemType);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }

      throw error;
    }
  }

  async markSuccess({
    meal,
    gateScore,
  }: MealRepository.MarkSuccessParams): Promise<boolean> {
    const expressionAttributeValues: Record<string, unknown> = {
      ':processing': Meal.StatusType.PROCESSING,
      ':success': Meal.StatusType.SUCCESS,
      ':name': meal.name,
      ':icon': meal.icon,
      ':foods': meal.foods,
    };
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
      '#leaseExpiresAt': 'leaseExpiresAt',
      '#name': 'name',
      '#icon': 'icon',
      '#foods': 'foods',
    };
    let updateExpression = 'SET #status = :success, #name = :name, #icon = :icon, #foods = :foods REMOVE #leaseExpiresAt';

    if (gateScore !== undefined && gateScore !== null) {
      expressionAttributeNames['#gateScore'] = 'gateScore';
      expressionAttributeValues[':gateScore'] = gateScore;
      updateExpression = 'SET #status = :success, #name = :name, #icon = :icon, #foods = :foods, #gateScore = :gateScore REMOVE #leaseExpiresAt';
    }

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealRepository.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      UpdateExpression: updateExpression,
      ConditionExpression: '#status = :processing',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'NONE',
    });

    return this.sendConditional(command);
  }

  async failAndRefund({ meal }: MealRepository.FailAndRefundParams): Promise<MealRepository.FailAndRefundResult> {
    if (meal.status !== Meal.StatusType.PROCESSING && meal.status !== Meal.StatusType.QUEUED) {
      return {
        failed: false,
        refunded: false,
      };
    }

    if (!meal.quotaMonth) {
      const failed = await this.markFailed({
        meal,
        quotaRefunded: false,
      });

      return {
        failed,
        refunded: false,
      };
    }

    const failedUpdate = MealRepository.buildFailedUpdate({
      quotaRefunded: true,
    });
    const failedCondition = MealRepository.buildFailedCondition(meal);

    const command = new TransactWriteCommand({
      ClientRequestToken: `${meal.id}#fail#${meal.attempts}`,
      TransactItems: [
        {
          Update: {
            TableName: this.config.db.dynamodb.mainTable,
            Key: MealRepository.getKey({
              accountId: meal.accountId,
              mealId: meal.id,
            }),
            UpdateExpression: failedUpdate.updateExpression,
            ConditionExpression: failedCondition.conditionExpression,
            ExpressionAttributeNames: {
              ...failedUpdate.expressionAttributeNames,
              ...failedCondition.expressionAttributeNames,
            },
            ExpressionAttributeValues: {
              ...failedUpdate.expressionAttributeValues,
              ...failedCondition.expressionAttributeValues,
            },
          },
        },
        {
          Update: {
            TableName: this.config.db.dynamodb.rateLimitTable,
            Key: RateLimitRepository.getCalendarMonthKey({
              scope: 'account-monthly',
              key: meal.accountId,
              bucket: meal.quotaMonth,
            }),
            UpdateExpression: 'ADD #count :dec',
            ConditionExpression: '#count > :zero',
            ExpressionAttributeNames: {
              '#count': 'count',
            },
            ExpressionAttributeValues: {
              ':dec': -1,
              ':zero': 0,
            },
          },
        },
      ],
    });

    try {
      await dynamodbClient.send(command);
      return {
        failed: true,
        refunded: true,
      };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }

      const mealConditionFailed = error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      const quotaConditionFailed = error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed';

      if (quotaConditionFailed) {
        const failed = await this.markFailed({
          meal,
          quotaRefunded: false,
        });

        return {
          failed,
          refunded: false,
        };
      }

      if (mealConditionFailed) {
        return {
          failed: false,
          refunded: false,
        };
      }

      throw error;
    }
  }

  private async markFailed({
    meal,
    quotaRefunded,
  }: MealRepository.MarkFailedParams): Promise<boolean> {
    const failedUpdate = MealRepository.buildFailedUpdate({ quotaRefunded });
    const failedCondition = MealRepository.buildFailedCondition(meal);

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealRepository.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      UpdateExpression: failedUpdate.updateExpression,
      ConditionExpression: failedCondition.conditionExpression,
      ExpressionAttributeNames: {
        ...failedUpdate.expressionAttributeNames,
        ...failedCondition.expressionAttributeNames,
      },
      ExpressionAttributeValues: {
        ...failedUpdate.expressionAttributeValues,
        ...failedCondition.expressionAttributeValues,
      },
      ReturnValues: 'NONE',
    });

    return this.sendConditional(command);
  }

  async markRejected({
    accountId,
    mealId,
    reason,
    gateScore,
    quotaRefunded,
  }: MealRepository.MarkRejectedParams): Promise<boolean> {
    const {
      updateExpression,
      expressionAttributeNames,
      expressionAttributeValues,
    } = MealRepository.buildRejectedUpdate({
      reason,
      gateScore,
      quotaRefunded,
    });

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealRepository.getKey({ accountId, mealId }),
      UpdateExpression: updateExpression,
      ConditionExpression: '#status = :processing',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'NONE',
    });

    return this.sendConditional(command);
  }

  async rejectAndRefund({
    meal,
    reason,
    gateScore,
  }: MealRepository.RejectAndRefundParams): Promise<MealRepository.RejectAndRefundResult> {
    if (!meal.quotaMonth) {
      const rejected = await this.markRejected({
        accountId: meal.accountId,
        mealId: meal.id,
        reason,
        gateScore,
        quotaRefunded: false,
      });

      return {
        rejected,
        refunded: false,
      };
    }

    const {
      updateExpression,
      expressionAttributeNames,
      expressionAttributeValues,
    } = MealRepository.buildRejectedUpdate({
      reason,
      gateScore,
      quotaRefunded: true,
    });

    const command = new TransactWriteCommand({
      ClientRequestToken: `${meal.id}#reject#${meal.attempts}`,
      TransactItems: [
        {
          Update: {
            TableName: this.config.db.dynamodb.mainTable,
            Key: MealRepository.getKey({
              accountId: meal.accountId,
              mealId: meal.id,
            }),
            UpdateExpression: updateExpression,
            ConditionExpression: '#status = :processing',
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
          },
        },
        {
          Update: {
            TableName: this.config.db.dynamodb.rateLimitTable,
            Key: RateLimitRepository.getCalendarMonthKey({
              scope: 'account-monthly',
              key: meal.accountId,
              bucket: meal.quotaMonth,
            }),
            UpdateExpression: 'ADD #count :dec',
            ConditionExpression: '#count > :zero',
            ExpressionAttributeNames: {
              '#count': 'count',
            },
            ExpressionAttributeValues: {
              ':dec': -1,
              ':zero': 0,
            },
          },
        },
      ],
    });

    try {
      await dynamodbClient.send(command);
      return {
        rejected: true,
        refunded: true,
      };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }

      const mealConditionFailed = error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      const quotaConditionFailed = error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed';

      if (quotaConditionFailed) {
        const rejected = await this.markRejected({
          accountId: meal.accountId,
          mealId: meal.id,
          reason,
          gateScore,
          quotaRefunded: false,
        });

        return {
          rejected,
          refunded: false,
        };
      }

      if (mealConditionFailed) {
        return {
          rejected: false,
          refunded: false,
        };
      }

      throw error;
    }
  }

  private static buildFailedUpdate({
    quotaRefunded,
  }: MealRepository.BuildFailedUpdateParams): MealRepository.FailedUpdate {
    return {
      updateExpression: 'SET #status = :failed, #quotaRefunded = :quotaRefunded REMOVE #leaseExpiresAt',
      expressionAttributeNames: {
        '#status': 'status',
        '#quotaRefunded': 'quotaRefunded',
        '#leaseExpiresAt': 'leaseExpiresAt',
      },
      expressionAttributeValues: {
        ':failed': Meal.StatusType.FAILED,
        ':quotaRefunded': quotaRefunded,
      },
    };
  }

  private static buildFailedCondition(meal: Meal): MealRepository.FailedCondition {
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
      '#attempts': 'attempts',
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ':attempts': meal.attempts,
    };

    if (meal.status === Meal.StatusType.QUEUED) {
      expressionAttributeValues[':queued'] = Meal.StatusType.QUEUED;

      return {
        conditionExpression: '#status = :queued AND #attempts = :attempts',
        expressionAttributeNames,
        expressionAttributeValues,
      };
    }

    expressionAttributeNames['#leaseExpiresAt'] = 'leaseExpiresAt';
    expressionAttributeValues[':processing'] = Meal.StatusType.PROCESSING;

    if (meal.leaseExpiresAt === null) {
      return {
        conditionExpression: '#status = :processing AND #attempts = :attempts AND attribute_not_exists(#leaseExpiresAt)',
        expressionAttributeNames,
        expressionAttributeValues,
      };
    }

    expressionAttributeValues[':leaseExpiresAt'] = meal.leaseExpiresAt;

    return {
      conditionExpression: '#status = :processing AND #attempts = :attempts AND #leaseExpiresAt = :leaseExpiresAt',
      expressionAttributeNames,
      expressionAttributeValues,
    };
  }

  private static buildRejectedUpdate({
    reason,
    gateScore,
    quotaRefunded,
  }: MealRepository.BuildRejectedUpdateParams): MealRepository.RejectedUpdate {
    const expressionAttributeValues: Record<string, unknown> = {
      ':processing': Meal.StatusType.PROCESSING,
      ':rejected': Meal.StatusType.REJECTED,
      ':reason': reason,
      ':rejectedAt': new Date().toISOString(),
      ':quotaRefunded': quotaRefunded,
    };
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
      '#leaseExpiresAt': 'leaseExpiresAt',
      '#rejectionReason': 'rejectionReason',
      '#rejectedAt': 'rejectedAt',
      '#quotaRefunded': 'quotaRefunded',
    };
    let updateExpression = 'SET #status = :rejected, #rejectionReason = :reason, #rejectedAt = :rejectedAt, #quotaRefunded = :quotaRefunded REMOVE #leaseExpiresAt';

    if (gateScore !== undefined && gateScore !== null) {
      expressionAttributeNames['#gateScore'] = 'gateScore';
      expressionAttributeValues[':gateScore'] = gateScore;
      updateExpression = 'SET #status = :rejected, #rejectionReason = :reason, #rejectedAt = :rejectedAt, #quotaRefunded = :quotaRefunded, #gateScore = :gateScore REMOVE #leaseExpiresAt';
    }

    return {
      updateExpression,
      expressionAttributeNames,
      expressionAttributeValues,
    };
  }

  private async sendConditional(command: UpdateCommand): Promise<boolean> {
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

  private static getKey({ accountId, mealId }: MealRepository.FindByIdParams): MealRepository.Key {
    return {
      PK: MealItem.getPK({ accountId, mealId }),
      SK: MealItem.getSK(mealId),
    };
  }

  async findById({ accountId, mealId }: MealRepository.FindByIdParams): Promise<Meal | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: MealItem.getPK({ accountId, mealId }),
        SK: MealItem.getSK(mealId),
      },
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    const mealItem = Item as MealItem.ItemType;

    const meal = MealItem.toEntity(mealItem);

    return meal;
  }

  async create(meal: Meal): Promise<void> {
    const mealItem = MealItem.fromEntity(meal);

    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: mealItem.getItem(),
    });

    await dynamodbClient.send(command);
  }

}

namespace MealRepository {

  export type FindByIdParams = {
    accountId: string;
    mealId: string;
  }

  export type Key = {
    PK: string;
    SK: string;
  }

  export type MarkForRetryParams = FindByIdParams & {
    leaseExpiresAt: number;
  }

  export type ClaimForProcessingParams = FindByIdParams & {
    leaseExpiresAt: number;
    now: number;
  }

  export type MarkSuccessParams = {
    meal: Meal;
    gateScore?: number | null;
  }

  export type MarkRejectedParams = FindByIdParams & {
    reason: Meal.RejectionReason;
    gateScore?: number | null;
    quotaRefunded: boolean;
  }

  export type BuildRejectedUpdateParams = {
    reason: Meal.RejectionReason;
    gateScore?: number | null;
    quotaRefunded: boolean;
  }

  export type RejectedUpdate = {
    updateExpression: string;
    expressionAttributeNames: Record<string, string>;
    expressionAttributeValues: Record<string, unknown>;
  }

  export type FailAndRefundParams = {
    meal: Meal;
  }

  export type FailAndRefundResult = {
    failed: boolean;
    refunded: boolean;
  }

  export type MarkFailedParams = {
    meal: Meal;
    quotaRefunded: boolean;
  }

  export type BuildFailedUpdateParams = {
    quotaRefunded: boolean;
  }

  export type FailedUpdate = {
    updateExpression: string;
    expressionAttributeNames: Record<string, string>;
    expressionAttributeValues: Record<string, unknown>;
  }

  export type FailedCondition = {
    conditionExpression: string;
    expressionAttributeNames: Record<string, string>;
    expressionAttributeValues: Record<string, unknown>;
  }

  export type RejectAndRefundParams = {
    meal: Meal;
    reason: Meal.RejectionReason;
    gateScore?: number | null;
  }

  export type RejectAndRefundResult = {
    rejected: boolean;
    refunded: boolean;
  }
}
