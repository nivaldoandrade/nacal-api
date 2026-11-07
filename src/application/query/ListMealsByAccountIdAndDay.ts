import { Meal } from '@application/entities/Meal';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { MealItem } from '@infra/databases/dynamodb/items/MealItem';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class ListMealsByAccountIdAndDay {

  constructor(private readonly config: AppConfig) { }

  async execute({ accountId, date }: ListMealsByAccountIdAndDay.Input): Promise<ListMealsByAccountIdAndDay.Output> {

    const command = new QueryCommand({
      TableName: this.config.db.dynamodb.mainTable,
      IndexName: 'GSI1',
      Select: 'SPECIFIC_ATTRIBUTES',
      ProjectionExpression: '#createdAt, #foods, #icon, #id, #name',
      ScanIndexForward: false,
      KeyConditionExpression: '#GSI1PK = :GSI1PK',
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#GSI1PK': 'GSI1PK',
        '#createdAt': 'createdAt',
        '#foods': 'foods',
        '#icon': 'icon',
        '#id': 'id',
        '#name': 'name',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':GSI1PK': MealItem.GSI1PK({
          accountId,
          day: date,
        }),
        ':status': Meal.StatusType.SUCCESS,
      },
    });

    const { Items = [] } = await dynamodbClient.send(command);

    const items = Items as ListMealsByAccountIdAndDay.ItemType[];

    const meals: ListMealsByAccountIdAndDay.Output['meals'] = items.map(
      item => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        foods: item.foods,
        createdAt: item.createdAt,
      }),
    );

    return {
      meals,
    };
  }
}

export namespace ListMealsByAccountIdAndDay {
  export type Input = {
    accountId: string;
    date: string;
  }

  export type ItemType = {
    id: string;
    name: string;
    icon: string;
    foods: Meal.FoodType[];
    createdAt: string;
  }

  export type Output = {
    meals: {
      id: string;
      name: string;
      icon: string;
      foods: Meal.FoodType[];
      createdAt: string;
    }[]
  }
}
