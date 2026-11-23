import { Meal } from '@application/entities/Meal';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { MealItem } from '@infra/databases/dynamodb/items/MealItem';
import { sendConditional, sendConditionalUpdate } from '@infra/databases/dynamodb/utils/sendConditionalUpdate';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class MealRepository {

  constructor(private readonly config: AppConfig) { }

  async findById({ accountId, mealId, consistentRead }: MealRepository.FindByIdParams): Promise<Meal | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({ accountId, mealId }),
      ConsistentRead: consistentRead,
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    return MealItem.toEntity(Item as MealItem.ItemType);
  }

  async findActiveById(params: MealRepository.FindByIdParams): Promise<Meal | null> {
    const meal = await this.findById(params);

    if (!meal || meal.status === Meal.StatusType.DELETED) {
      return null;
    }

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

  async appendFoods({
    meal,
    foods,
    now,
  }: MealRepository.AppendFoodsParams): Promise<Meal | null> {
    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      UpdateExpression: [
        'SET #foods = list_append(if_not_exists(#foods, :empty), :newFoods),',
        '#itemAdditions = if_not_exists(#itemAdditions, :zero) + :one,',
        '#foodsVersion = if_not_exists(#foodsVersion, :zero) + :one,',
        '#editedAt = :now',
      ].join(' '),
      ConditionExpression: [
        '#status = :success',
        MealRepository.getFoodsVersionCondition(meal.foodsVersion),
        '(attribute_not_exists(#itemAdditions) OR #itemAdditions < :maxAdditions)',
        '(attribute_not_exists(#foods) OR size(#foods) <= :maxFoodsBefore)',
        '#createdAt >= :windowStart',
      ].join(' AND '),
      ExpressionAttributeNames: {
        '#status': 'status',
        '#createdAt': 'createdAt',
        '#foods': 'foods',
        '#itemAdditions': 'itemAdditions',
        '#foodsVersion': 'foodsVersion',
        '#editedAt': 'editedAt',
      },
      ExpressionAttributeValues: {
        ':success': Meal.StatusType.SUCCESS,
        ':newFoods': foods,
        ':empty': [],
        ':zero': 0,
        ':one': 1,
        ':now': now.toISOString(),
        ':expectedVersion': meal.foodsVersion,
        ':maxAdditions': Meal.MAX_ITEM_ADDITIONS,
        ':maxFoodsBefore': Meal.MAX_FOODS - foods.length,
        ':windowStart': new Date(now.getTime() - (Meal.EDIT_WINDOW_HOURS * 60 * 60 * 1000)).toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const output = await sendConditionalUpdate(command);

    if (!output?.Attributes) {
      return null;
    }

    return MealItem.toEntity(output.Attributes as MealItem.ItemType);
  }

  async saveFoods({
    meal,
    expectedVersion,
  }: MealRepository.SaveFoodsParams): Promise<Meal | null> {
    const expressionAttributeValues: Record<string, unknown> = {
      ':success': Meal.StatusType.SUCCESS,
      ':foods': meal.foods,
      ':removedFoods': meal.removedFoods,
      ':editedAt': meal.editedAt?.toISOString() ?? null,
      ':expectedVersion': expectedVersion,
      ':nextVersion': expectedVersion + 1,
    };
    const conditions = [
      '#status = :success',
      MealRepository.getFoodsVersionCondition(expectedVersion),
    ];

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      UpdateExpression: [
        'SET #foods = :foods,',
        '#removedFoods = :removedFoods,',
        '#editedAt = :editedAt,',
        '#foodsVersion = :nextVersion',
      ].join(' '),
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: {
        '#status': 'status',
        '#foods': 'foods',
        '#removedFoods': 'removedFoods',
        '#editedAt': 'editedAt',
        '#foodsVersion': 'foodsVersion',
      },
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const output = await sendConditionalUpdate(command);

    if (!output?.Attributes) {
      return null;
    }

    return MealItem.toEntity(output.Attributes as MealItem.ItemType);
  }

  async markDeleted({ meal, now }: MealRepository.MarkDeletedParams): Promise<boolean> {
    const statusValues = Object.fromEntries(
      Meal.deletableStatuses.map((status, index) => [`:status${index}`, status]),
    );

    const command = new UpdateCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: MealItem.getKey({
        accountId: meal.accountId,
        mealId: meal.id,
      }),
      UpdateExpression: 'SET #status = :deleted, #deletedAt = :now',
      ConditionExpression: `#status IN (${Object.keys(statusValues).join(', ')})`,
      ExpressionAttributeNames: {
        '#status': 'status',
        '#deletedAt': 'deletedAt',
      },
      ExpressionAttributeValues: {
        ...statusValues,
        ':deleted': Meal.StatusType.DELETED,
        ':now': now.toISOString(),
      },
      ReturnValues: 'NONE',
    });

    return sendConditional(command);
  }

  private static getFoodsVersionCondition(expectedVersion: number): string {
    if (expectedVersion === 0) {
      return '(attribute_not_exists(#foodsVersion) OR #foodsVersion = :expectedVersion)';
    }

    return '#foodsVersion = :expectedVersion';
  }

}

export namespace MealRepository {

  export type FindByIdParams = {
    accountId: string;
    mealId: string;
    consistentRead?: boolean;
  }

  export type AppendFoodsParams = {
    meal: Meal;
    foods: Meal.FoodType[];
    now: Date;
  }

  export type SaveFoodsParams = {
    meal: Meal;
    expectedVersion: number;
  }

  export type MarkDeletedParams = {
    meal: Meal;
    now: Date;
  }
}
