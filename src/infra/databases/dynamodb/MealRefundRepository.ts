import { Meal } from '@application/entities/Meal';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { MealItem } from '@infra/databases/dynamodb/items/MealItem';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { sendConditional } from '@infra/databases/dynamodb/utils/sendConditionalUpdate';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class MealRefundRepository {

  constructor(private readonly config: AppConfig) { }

  async failAndRefund({ meal }: MealRefundRepository.FailAndRefundParams): Promise<MealRefundRepository.FailAndRefundResult> {
    if (!MealRefundRepository.failableStatuses.includes(meal.status)) {
      return {
        failed: false,
        refunded: false,
      };
    }

    const { applied, refunded } = await this.settle({
      meal,
      clientRequestToken: MealRefundRepository.buildFailRequestToken(meal),
      condition: MealRefundRepository.buildFailedCondition(meal),
      buildUpdate: MealRefundRepository.buildFailedUpdate,
      extraItems: [],
    });

    return {
      failed: applied,
      refunded,
    };
  }

  async rejectAndRefund({
    meal,
    reason,
    gateScore,
    refundLimit,
  }: MealRefundRepository.RejectAndRefundParams): Promise<MealRefundRepository.RejectAndRefundResult> {
    const { applied, refunded } = await this.settle({
      meal,
      clientRequestToken: `${meal.id}#reject#${meal.attempts}`,
      condition: MealRefundRepository.processingCondition,
      buildUpdate: (quotaRefunded) => MealRefundRepository.buildRejectedUpdate({
        reason,
        gateScore,
        quotaRefunded,
      }),
      extraItems: [
        {
          Update: {
            TableName: this.config.db.dynamodb.rateLimitTable,
            ...RateLimitRepository.buildQuotaCounterIncrement({
              scope: 'account-rejections',
              key: meal.accountId,
              ...refundLimit,
            }),
          },
        },
      ],
    });

    return {
      rejected: applied,
      refunded,
    };
  }

  private async settle({
    meal,
    clientRequestToken,
    condition,
    buildUpdate,
    extraItems,
  }: MealRefundRepository.SettleParams): Promise<MealRefundRepository.SettleResult> {
    if (!meal.quotaMonth) {
      return {
        applied: await this.updateMeal({ meal, update: buildUpdate(false), condition }),
        refunded: false,
      };
    }

    const command = new TransactWriteCommand({
      ClientRequestToken: clientRequestToken,
      TransactItems: [
        {
          Update: {
            TableName: this.config.db.dynamodb.mainTable,
            Key: MealItem.getKey({
              accountId: meal.accountId,
              mealId: meal.id,
            }),
            ...MealRefundRepository.toUpdateInput(buildUpdate(true), condition),
          },
        },
        ...this.buildQuotaRefundItems({
          accountId: meal.accountId,
          quotaMonth: meal.quotaMonth,
          quotaDay: meal.quotaDay,
        }),
        ...extraItems,
      ],
    });

    try {
      await dynamodbClient.send(command);
      return {
        applied: true,
        refunded: true,
      };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }

      if (MealRefundRepository.hasQuotaConditionFailed(error)) {
        return {
          applied: await this.updateMeal({ meal, update: buildUpdate(false), condition }),
          refunded: false,
        };
      }

      if (error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        return {
          applied: false,
          refunded: false,
        };
      }

      throw error;
    }
  }

  private async updateMeal({ meal, update, condition }: MealRefundRepository.UpdateMealParams): Promise<boolean> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      ...MealRefundRepository.toUpdateInput(update, condition),
      ReturnValues: 'NONE',
    });

    return sendConditional(command);
  }

  private buildQuotaRefundItems({
    accountId,
    quotaMonth,
    quotaDay,
  }: MealRefundRepository.QuotaRefundParams): MealRefundRepository.QuotaCounterItem[] {
    const counters: RateLimitRepository.QuotaCounterKeyParams[] = [
      { scope: 'account-monthly', key: accountId, bucket: quotaMonth },
    ];

    if (quotaDay) {
      counters.push({ scope: 'account-daily', key: accountId, bucket: quotaDay });
    }

    return counters.map((counter) => ({
      Update: {
        TableName: this.config.db.dynamodb.rateLimitTable,
        ...RateLimitRepository.buildQuotaCounterDecrement(counter),
      },
    }));
  }

  private static toUpdateInput(
    update: MealRefundRepository.ExpressionParts,
    condition: MealRefundRepository.ExpressionParts,
  ): MealRefundRepository.UpdateInput {
    return {
      UpdateExpression: update.expression,
      ConditionExpression: condition.expression,
      ExpressionAttributeNames: {
        ...update.names,
        ...condition.names,
      },
      ExpressionAttributeValues: {
        ...update.values,
        ...condition.values,
      },
    };
  }

  private static hasQuotaConditionFailed(error: TransactionCanceledException): boolean {
    return (error.CancellationReasons ?? [])
      .slice(1)
      .some((reason) => reason.Code === 'ConditionalCheckFailed');
  }

  private static buildFailedUpdate(quotaRefunded: boolean): MealRefundRepository.ExpressionParts {
    return {
      expression: 'SET #status = :failed, #quotaRefunded = :quotaRefunded REMOVE #leaseExpiresAt',
      names: {
        '#status': 'status',
        '#quotaRefunded': 'quotaRefunded',
        '#leaseExpiresAt': 'leaseExpiresAt',
      },
      values: {
        ':failed': Meal.StatusType.FAILED,
        ':quotaRefunded': quotaRefunded,
      },
    };
  }

  private static buildFailedCondition(meal: Meal): MealRefundRepository.ExpressionParts {
    if (meal.status === Meal.StatusType.UPLOADING) {
      return {
        expression: '#status = :uploading',
        names: {
          '#status': 'status',
        },
        values: {
          ':uploading': Meal.StatusType.UPLOADING,
        },
      };
    }

    const names: Record<string, string> = {
      '#status': 'status',
      '#attempts': 'attempts',
    };
    const values: Record<string, unknown> = {
      ':attempts': meal.attempts,
    };

    if (meal.status === Meal.StatusType.QUEUED) {
      values[':queued'] = Meal.StatusType.QUEUED;

      return {
        expression: '#status = :queued AND #attempts = :attempts',
        names,
        values,
      };
    }

    names['#leaseExpiresAt'] = 'leaseExpiresAt';
    values[':processing'] = Meal.StatusType.PROCESSING;

    if (meal.leaseExpiresAt === null) {
      return {
        expression: '#status = :processing AND #attempts = :attempts AND attribute_not_exists(#leaseExpiresAt)',
        names,
        values,
      };
    }

    values[':leaseExpiresAt'] = meal.leaseExpiresAt;

    return {
      expression: '#status = :processing AND #attempts = :attempts AND #leaseExpiresAt = :leaseExpiresAt',
      names,
      values,
    };
  }

  private static buildRejectedUpdate({
    reason,
    gateScore,
    quotaRefunded,
  }: MealRefundRepository.BuildRejectedUpdateParams): MealRefundRepository.ExpressionParts {
    const names: Record<string, string> = {
      '#status': 'status',
      '#leaseExpiresAt': 'leaseExpiresAt',
      '#rejectionReason': 'rejectionReason',
      '#rejectedAt': 'rejectedAt',
      '#quotaRefunded': 'quotaRefunded',
    };
    const values: Record<string, unknown> = {
      ':rejected': Meal.StatusType.REJECTED,
      ':reason': reason,
      ':rejectedAt': new Date().toISOString(),
      ':quotaRefunded': quotaRefunded,
    };
    const setClauses = [
      '#status = :rejected',
      '#rejectionReason = :reason',
      '#rejectedAt = :rejectedAt',
      '#quotaRefunded = :quotaRefunded',
    ];

    if (gateScore !== undefined && gateScore !== null) {
      names['#gateScore'] = 'gateScore';
      values[':gateScore'] = gateScore;
      setClauses.push('#gateScore = :gateScore');
    }

    return {
      expression: `SET ${setClauses.join(', ')} REMOVE #leaseExpiresAt`,
      names,
      values,
    };
  }

  private static buildFailRequestToken(meal: Meal): string {
    if (meal.status === Meal.StatusType.UPLOADING) {
      return `${meal.id}#upload`;
    }

    return `${meal.id}#fail#${meal.attempts}`;
  }

  private static readonly processingCondition: MealRefundRepository.ExpressionParts = {
    expression: '#status = :processing',
    names: {
      '#status': 'status',
    },
    values: {
      ':processing': Meal.StatusType.PROCESSING,
    },
  };

  private static readonly failableStatuses: Meal.StatusType[] = [
    Meal.StatusType.UPLOADING,
    Meal.StatusType.QUEUED,
    Meal.StatusType.PROCESSING,
  ];

}

export namespace MealRefundRepository {

  export type FailAndRefundParams = {
    meal: Meal;
  }

  export type FailAndRefundResult = {
    failed: boolean;
    refunded: boolean;
  }

  export type RejectAndRefundParams = {
    meal: Meal;
    reason: Meal.RejectionReason;
    gateScore?: number | null;
    refundLimit: RefundLimit;
  }

  export type RefundLimit = {
    bucket: string;
    expiresAt: number;
    limit: number;
  }

  export type RejectAndRefundResult = {
    rejected: boolean;
    refunded: boolean;
  }

  export type BuildRejectedUpdateParams = {
    reason: Meal.RejectionReason;
    gateScore?: number | null;
    quotaRefunded: boolean;
  }

  export type ExpressionParts = {
    expression: string;
    names: Record<string, string>;
    values: Record<string, unknown>;
  }

  export type UpdateInput = {
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  }

  export type QuotaRefundParams = {
    accountId: string;
    quotaMonth: string;
    quotaDay: string | null;
  }

  export type QuotaCounterItem = {
    Update: RateLimitRepository.QuotaCounterUpdate & {
      TableName: string;
    };
  }

  export type SettleParams = {
    meal: Meal;
    clientRequestToken: string;
    condition: ExpressionParts;
    buildUpdate: (quotaRefunded: boolean) => ExpressionParts;
    extraItems: QuotaCounterItem[];
  }

  export type SettleResult = {
    applied: boolean;
    refunded: boolean;
  }

  export type UpdateMealParams = {
    meal: Meal;
    update: ExpressionParts;
    condition: ExpressionParts;
  }
}
