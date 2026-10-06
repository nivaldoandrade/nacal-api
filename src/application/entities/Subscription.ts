import { ValueOf } from '@shared/utils/ValueOf';

export class Subscription {
  static readonly GRACE_DAYS = 3;

  readonly accountId: string;

  gateway: Subscription.Attributes['gateway'];

  status: Subscription.StatusType;

  planId: Subscription.PlanIdType;

  gatewayRefs?: Subscription.GatewayRefs;

  trialStartedAt: Date;

  trialEndsAt?: Date;

  paidUntil?: Date;

  canceledAt?: Date;

  readonly createdAt: Date;

  constructor(attr: Subscription.Attributes) {
    this.accountId = attr.accountId;
    this.gateway = attr.gateway;
    this.status = attr.status;
    this.planId = attr.planId;
    this.gatewayRefs = attr.gatewayRefs;
    this.trialStartedAt = attr.trialStartedAt;
    this.trialEndsAt = attr.trialEndsAt;
    this.paidUntil = attr.paidUntil;
    this.canceledAt = attr.canceledAt;
    this.createdAt = attr.createdAt ?? new Date();
  }

  static resolveEffectivePlan(
    subscription: Pick<Subscription, 'status' | 'trialEndsAt' | 'paidUntil'> | null,
    now: Date = new Date(),
  ): Subscription.EffectivePlan {
    if (!subscription) {
      return 'FREE';
    }

    const graceDeadline = subscription.paidUntil
      ? new Date(subscription.paidUntil.getTime() + Subscription.GRACE_DAYS * 86_400_000)
      : null;

    switch (subscription.status) {
      case Subscription.Status.TRIALING:
        return subscription.trialEndsAt && subscription.trialEndsAt > now ? 'PRO' : 'FREE';
      case Subscription.Status.ACTIVE:
      case Subscription.Status.PAST_DUE:
        return graceDeadline && graceDeadline > now ? 'PRO' : 'FREE';
      case Subscription.Status.CANCELED:
        return subscription.paidUntil && subscription.paidUntil > now ? 'PRO' : 'FREE';
      case Subscription.Status.EXPIRED:
      default:
        return 'FREE';
    }
  }

}

export namespace Subscription {
  export type Attributes = {
    accountId: string;
    gateway: 'ASAAS';
    status: StatusType;
    planId: PlanIdType;
    gatewayRefs?: GatewayRefs;
    trialStartedAt: Date;
    trialEndsAt?: Date;
    paidUntil?: Date;
    canceledAt?: Date;
    createdAt?: Date;
  }

  export const Status = {
    TRIALING: 'TRIALING',
    ACTIVE: 'ACTIVE',
    PAST_DUE: 'PAST_DUE',
    CANCELED: 'CANCELED',
    EXPIRED: 'EXPIRED',
  } as const;

  export type StatusType = ValueOf<typeof Status>;

  export const PlanId = {
    PRO_MONTHLY: 'PRO_MONTHLY',
    PRO_YEARLY: 'PRO_YEARLY',
  } as const;

  export type PlanIdType = ValueOf<typeof PlanId>;

  export const Plan = {
    PRO_MONTHLY: {
      id: 'PRO_MONTHLY',
      name: 'Pro Mensal',
      priceCents: 999,
      cycle: 'MONTHLY',
      trialDays: 7,
      features: ['Refeições AI ilimitadas'],
    },
    PRO_YEARLY: {
      id: 'PRO_YEARLY',
      name: 'Pro Anual',
      priceCents: 9990,
      cycle: 'YEARLY',
      trialDays: 7,
      features: ['Refeições AI ilimitadas'],
    },
  } as const;

  export type EffectivePlan = 'FREE' | 'PRO';

  export type GatewayRefs = {
    customerId?: string;
    subscriptionId?: string;
    checkoutId?: string;
  };
}
