import { Meal } from '@application/entities/Meal';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MealItem } from '@infra/databases/dynamodb/items/MealItem';
import { sendConditional, sendConditionalUpdate } from '@infra/databases/dynamodb/utils/sendConditionalUpdate';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class MealProcessingRepository {

  constructor(private readonly config: AppConfig) { }

  async markQueued({ accountId, mealId }: MealProcessingRepository.KeyParams): Promise<boolean> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({ accountId, mealId }),
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

    return sendConditional(command);
  }

  async markForRetry({
    accountId,
    mealId,
    leaseExpiresAt,
  }: MealProcessingRepository.MarkForRetryParams): Promise<boolean> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({ accountId, mealId }),
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

    return sendConditional(command);
  }

  async claimForProcessing({
    accountId,
    mealId,
    leaseExpiresAt,
    now,
  }: MealProcessingRepository.ClaimForProcessingParams): Promise<Meal | null> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({ accountId, mealId }),
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

    const output = await sendConditionalUpdate(command);

    if (!output?.Attributes) {
      return null;
    }

    return MealItem.toEntity(output.Attributes as MealItem.ItemType);
  }

  async markSuccess({
    meal,
    gateScore,
  }: MealProcessingRepository.MarkSuccessParams): Promise<boolean> {
    const expressionAttributeValues: Record<string, unknown> = {
      ':processing': Meal.StatusType.PROCESSING,
      ':success': Meal.StatusType.SUCCESS,
      ':name': meal.name,
      ':icon': meal.icon,
      ':foods': meal.foods,
      ':unidentified': meal.unidentified,
    };
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
      '#leaseExpiresAt': 'leaseExpiresAt',
      '#name': 'name',
      '#icon': 'icon',
      '#foods': 'foods',
      '#unidentified': 'unidentified',
    };
    const setClauses = [
      '#status = :success',
      '#name = :name',
      '#icon = :icon',
      '#foods = :foods',
      '#unidentified = :unidentified',
    ];

    if (gateScore !== undefined && gateScore !== null) {
      expressionAttributeNames['#gateScore'] = 'gateScore';
      expressionAttributeValues[':gateScore'] = gateScore;
      setClauses.push('#gateScore = :gateScore');
    }

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      UpdateExpression: `SET ${setClauses.join(', ')} REMOVE #leaseExpiresAt`,
      ConditionExpression: '#status = :processing',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'NONE',
    });

    return sendConditional(command);
  }

}

export namespace MealProcessingRepository {

  export type KeyParams = {
    accountId: string;
    mealId: string;
  }

  export type MarkForRetryParams = KeyParams & {
    leaseExpiresAt: number;
  }

  export type ClaimForProcessingParams = KeyParams & {
    leaseExpiresAt: number;
    now: number;
  }

  export type MarkSuccessParams = {
    meal: Meal;
    gateScore?: number | null;
  }
}
