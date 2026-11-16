import { Subscription } from '@application/entities/Subscription';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { SubscriptionItem } from '@infra/databases/dynamodb/items/SubscriptionItem';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

const GATEWAY_REF_TYPE = 'GATEWAY_REF';

const PENDING_CHECKOUT_TYPE = 'PENDING_CHECKOUT';

const getGatewayRefPK = (gatewayId: string): string => `GATEWAY#${gatewayId}`;

const getPendingCheckoutPK = (accountId: string): string => `PENDING_CHECKOUT#${accountId}`;

@Injectable()
export class SubscriptionRepository {
  static readonly MAX_WRITE_ATTEMPTS = 3;

  constructor(private readonly config: AppConfig) { }

  async findByAccountId(accountId: string): Promise<Subscription | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: SubscriptionItem.getPK(accountId),
        SK: SubscriptionItem.getSK(accountId),
      },
      ConsistentRead: true,
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    const subscriptionItem = Item as SubscriptionItem.ItemType;

    return SubscriptionItem.toEntity(subscriptionItem);
  }

  async save(subscription: Subscription): Promise<boolean> {
    const nextVersion = (subscription.version ?? 0) + 1;
    const subscriptionItem = {
      ...SubscriptionItem.fromEntity(subscription).getItem(),
      version: nextVersion,
    };

    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: subscriptionItem,
      ConditionExpression: subscription.version === undefined
        ? 'attribute_exists(#PK) AND attribute_not_exists(#version)'
        : 'attribute_exists(#PK) AND #version = :version',
      ExpressionAttributeNames: {
        '#PK': 'PK',
        '#version': 'version',
      },
      ...(subscription.version !== undefined && {
        ExpressionAttributeValues: {
          ':version': subscription.version,
        },
      }),
    });

    try {
      await dynamodbClient.send(command);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }

      throw error;
    }

    subscription.version = nextVersion;

    return true;
  }

  async create(subscription: Subscription): Promise<void> {
    const subscriptionItem = {
      ...SubscriptionItem.fromEntity(subscription).getItem(),
      version: 1,
    };

    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: subscriptionItem,
      ConditionExpression: 'attribute_not_exists(#SK)',
      ExpressionAttributeNames: {
        '#SK': 'SK',
      },
    });

    await dynamodbClient.send(command);

    subscription.version = 1;
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

  async savePendingCheckout({
    accountId,
    planId,
    returnUrl,
    checkoutId,
    checkoutUrl,
    checkoutExpiresAt,
  }: SubscriptionRepository.PendingCheckout): Promise<void> {
    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: {
        PK: getPendingCheckoutPK(accountId),
        SK: getPendingCheckoutPK(accountId),
        type: PENDING_CHECKOUT_TYPE,
        accountId,
        planId,
        returnUrl,
        checkoutId,
        checkoutUrl,
        checkoutExpiresAt: checkoutExpiresAt.toISOString(),
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(checkoutExpiresAt.getTime() / 1000),
      },
    });

    await dynamodbClient.send(command);
  }

  async findPendingCheckout(accountId: string): Promise<SubscriptionRepository.PendingCheckout | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: getPendingCheckoutPK(accountId),
        SK: getPendingCheckoutPK(accountId),
      },
      ConsistentRead: true,
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    const pendingCheckoutItem = Item as SubscriptionRepository.PendingCheckoutItem;

    return {
      accountId: pendingCheckoutItem.accountId,
      planId: pendingCheckoutItem.planId,
      returnUrl: pendingCheckoutItem.returnUrl,
      checkoutId: pendingCheckoutItem.checkoutId,
      checkoutUrl: pendingCheckoutItem.checkoutUrl,
      checkoutExpiresAt: new Date(pendingCheckoutItem.checkoutExpiresAt),
    };
  }

  async deletePendingCheckout({ accountId, checkoutId }: SubscriptionRepository.DeletePendingCheckoutParams): Promise<void> {
    const command = new DeleteCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: getPendingCheckoutPK(accountId),
        SK: getPendingCheckoutPK(accountId),
      },
      ConditionExpression: '#checkoutId = :checkoutId',
      ExpressionAttributeNames: {
        '#checkoutId': 'checkoutId',
      },
      ExpressionAttributeValues: {
        ':checkoutId': checkoutId,
      },
    });

    try {
      await dynamodbClient.send(command);
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
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

  export type PendingCheckout = {
    accountId: string;
    planId: Subscription.PlanIdType;
    returnUrl: string;
    checkoutId: string;
    checkoutUrl: string;
    checkoutExpiresAt: Date;
  };

  export type PendingCheckoutItem = Omit<PendingCheckout, 'checkoutExpiresAt'> & {
    checkoutExpiresAt: string;
  };

  export type DeletePendingCheckoutParams = {
    accountId: string;
    checkoutId: string;
  };
}
