import { Subscription } from '@application/entities/Subscription';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { SubscriptionItem } from '@infra/databases/dynamodb/items/SubscriptionItem';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

const GATEWAY_REF_TYPE = 'GATEWAY_REF';

const getGatewayRefPK = (gatewayId: string): string => `GATEWAY#${gatewayId}`;

@Injectable()
export class SubscriptionRepository {

  constructor(private readonly config: AppConfig) { }

  async findByAccountId(accountId: string): Promise<Subscription | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: SubscriptionItem.getPK(accountId),
        SK: SubscriptionItem.getSK(accountId),
      },
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    const subscriptionItem = Item as SubscriptionItem.ItemType;

    return SubscriptionItem.toEntity(subscriptionItem);
  }

  async save(subscription: Subscription): Promise<void> {
    const subscriptionItem = SubscriptionItem.fromEntity(subscription).getItem();

    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: subscriptionItem,
    });

    await dynamodbClient.send(command);
  }

  async create(subscription: Subscription): Promise<void> {
    const subscriptionItem = SubscriptionItem.fromEntity(subscription);

    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: subscriptionItem.getItem(),
      ConditionExpression: 'attribute_not_exists(#SK)',
      ExpressionAttributeNames: {
        '#SK': 'SK',
      },
    });

    await dynamodbClient.send(command);
  }

  async linkGatewayRef({ gatewayId, accountId, planId }: SubscriptionRepository.LinkGatewayRefParams): Promise<void> {
    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: {
        PK: getGatewayRefPK(gatewayId),
        SK: getGatewayRefPK(gatewayId),
        type: GATEWAY_REF_TYPE,
        accountId,
        planId,
        createdAt: new Date().toISOString(),
      },
    });

    await dynamodbClient.send(command);
  }

  async findGatewayRef(gatewayId: string): Promise<SubscriptionRepository.GatewayRef | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: getGatewayRefPK(gatewayId),
        SK: getGatewayRefPK(gatewayId),
      },
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    const gatewayRefItem = Item as SubscriptionRepository.GatewayRef;

    return {
      accountId: gatewayRefItem.accountId,
      planId: gatewayRefItem.planId,
    };
  }
}

export namespace SubscriptionRepository {
  export type LinkGatewayRefParams = {
    gatewayId: string;
    accountId: string;
    planId: Subscription.PlanIdType;
  };

  export type GatewayRef = {
    accountId: string;
    planId: Subscription.PlanIdType;
  };
}
