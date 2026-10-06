import { Subscription } from '@application/entities/Subscription';
import { AccountItem } from '@infra/databases/dynamodb/items/AccountItem';

export class SubscriptionItem {
  static readonly TYPE: SubscriptionItem.Type = 'SUBSCRIPTION';

  private readonly keys: SubscriptionItem.Keys;

  private constructor(private readonly attrs: SubscriptionItem.Attributes) {
    this.keys = {
      PK: SubscriptionItem.getPK(this.attrs.accountId),
      SK: SubscriptionItem.getSK(this.attrs.accountId),
    };
  }

  static fromEntity(subscription: Subscription): SubscriptionItem {
    return new SubscriptionItem({
      ...subscription,
      paidUntil: subscription.paidUntil?.toISOString(),
      trialStartedAt: subscription.trialStartedAt.toISOString(),
      trialEndsAt: subscription.trialEndsAt?.toISOString(),
      canceledAt: subscription.canceledAt?.toISOString(),
      createdAt: subscription.createdAt.toISOString(),
    });
  }

  static toEntity(subscriptionItemAttr: SubscriptionItem.Attributes): Subscription {
    return new Subscription({
      ...subscriptionItemAttr,
      paidUntil: subscriptionItemAttr.paidUntil
        ? new Date(subscriptionItemAttr.paidUntil)
        : undefined,
      trialStartedAt: new Date(subscriptionItemAttr.trialStartedAt),
      trialEndsAt: subscriptionItemAttr.trialEndsAt
        ? new Date(subscriptionItemAttr.trialEndsAt)
        : undefined,
      canceledAt: subscriptionItemAttr.canceledAt
        ? new Date(subscriptionItemAttr.canceledAt)
        : undefined,
      createdAt: new Date(subscriptionItemAttr.createdAt),
    });
  }

  getItem(): SubscriptionItem.ItemType {
    return {
      ...this.keys,
      ...this.attrs,
      type: SubscriptionItem.TYPE,
    };
  }

  static getPK(accountId: string): SubscriptionItem.Keys['PK'] {
    return `ACCOUNT#${accountId}`;
  }

  static getSK(accountId: string): SubscriptionItem.Keys['SK'] {
    return `ACCOUNT#${accountId}#SUBSCRIPTION`;
  }

}

export namespace SubscriptionItem {
  export type Type = 'SUBSCRIPTION';

  export type Keys = {
    PK: AccountItem.Keys['PK'];
    SK: `${AccountItem.Keys['PK']}#SUBSCRIPTION`;
  }

  export type Attributes = {
    accountId: string;
    gateway: 'ASAAS';
    status: Subscription.StatusType;
    planId: Subscription.PlanIdType;
    gatewayRefs?: Subscription.GatewayRefs;
    trialStartedAt: string;
    trialEndsAt?: string;
    paidUntil?: string;
    canceledAt?: string;
    createdAt: string;
  }

  export type ItemType = Keys & Attributes & {
    type: Type;
  }
}
