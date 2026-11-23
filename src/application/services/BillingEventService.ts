import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { BillingAlertService } from '@application/services/BillingAlertService';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class BillingEventService {
  static readonly APPLIED_PAYMENT_IDS_LIMIT = 24;

  static readonly REVERSAL_PERIOD_TOLERANCE_DAYS = 7;

  constructor(
    private readonly paymentGateway: IPaymentGateway,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly rateLimitRepository: RateLimitRepository,
    private readonly billingAlertService: BillingAlertService,
  ) { }

  async apply(
    event: IPaymentGateway.BillingEvent,
    { skipCoveredPayment = false, skipReversalAlert = false, eventTtlDays }: BillingEventService.ApplyOptions = {},
  ): Promise<BillingEventService.ApplyOutput> {
    const { eventId } = event;

    if (eventId && await this.rateLimitRepository.hasWebhookEvent({ scope: 'webhook-event', key: eventId })) {
      return { handled: true, applied: false, duplicate: true };
    }

    const subscriptionRef = 'subscriptionRef' in event ? event.subscriptionRef : undefined;
    const checkoutSession = 'checkoutSession' in event ? event.checkoutSession : undefined;
    const checkoutId = 'checkoutId' in event ? event.checkoutId : undefined;
    const checkoutRef = checkoutSession || checkoutId;

    const ref = event.externalReference?.split('#');
    const gatewayRef = !ref && checkoutRef
      ? await this.subscriptionRepository.findGatewayRef(checkoutRef)
      : null;
    const subGatewayRef = !ref && !gatewayRef && subscriptionRef
      ? await this.subscriptionRepository.findGatewayRef(subscriptionRef)
      : null;

    const accountId = ref?.[0] ?? gatewayRef?.accountId ?? subGatewayRef?.accountId;
    const planId = (ref?.[1] ?? gatewayRef?.planId ?? subGatewayRef?.planId) as Subscription.PlanIdType | undefined;
    const plan = planId ? Subscription.Plan[planId] : undefined;

    if (!accountId || !plan) {
      return { handled: false, applied: false };
    }

    if (subscriptionRef) {
      await this.subscriptionRepository.linkGatewayRef({
        gatewayId: subscriptionRef,
        accountId,
        planId: plan.id,
      });
    }

    const outcome = await this.applyToSubscription({
      event,
      accountId,
      plan,
      subscriptionRef,
      skipCoveredPayment,
    });

    if (eventId) {
      await this.rateLimitRepository.markWebhookEvent({ scope: 'webhook-event', key: eventId, ttlDays: eventTtlDays });
    }

    if (outcome.duplicateSubscriptionContext && event.type === 'PAYMENT_SUCCEEDED') {
      await this.billingAlertService.alertDuplicateSubscription({
        accountId,
        context: outcome.duplicateSubscriptionContext,
        paymentId: event.paymentId,
        subscriptionRef,
        dueDate: event.dueDate,
        amount: event.amount,
      });
    }

    if (outcome.reversal && event.type === 'PAYMENT_REVERSED' && !skipReversalAlert) {
      await this.billingAlertService.alertReversal({ accountId, event, subscriptionRef, reversal: outcome.reversal });
    }

    return { handled: true, applied: outcome.applied, accountId, reversal: outcome.reversal?.result };
  }

  private async applyToSubscription(params: BillingEventService.ApplyToSubscriptionParams): Promise<BillingEventService.EventOutcome> {
    const canceledGatewaySubscriptions = new Set<string>();

    for (let attempt = 1; attempt <= SubscriptionRepository.MAX_WRITE_ATTEMPTS; attempt++) {
      const existing = await this.subscriptionRepository.findByAccountId(params.accountId);
      const outcome = await this.applyToExisting({
        ...params,
        existing,
        now: new Date(),
        canceledGatewaySubscriptions,
      });

      if (!outcome.conflict) {
        return outcome;
      }
    }

    throw new Error('Subscription write conflict.');
  }

  private async applyToExisting(params: BillingEventService.ApplyToExistingParams): Promise<BillingEventService.EventOutcome> {
    const { event, accountId, subscriptionRef, existing } = params;

    switch (event.type) {
      case 'PAYMENT_SUCCEEDED':
        return this.applyPaymentSucceeded({ ...params, event });
      case 'PAYMENT_REVERSED':
        return this.applyPaymentReversed({ ...params, event });
      case 'PAYMENT_OVERDUE':
        if (!existing || existing.status === Subscription.Status.CANCELED || !this.isCurrentGatewaySubscription(existing, subscriptionRef)) {
          return { applied: true, conflict: false };
        }

        existing.status = Subscription.Status.PAST_DUE;

        return this.saveOutcome(existing);
      case 'SUBSCRIPTION_CANCELED':
        if (!existing || existing.status === Subscription.Status.CANCELED || !this.isCurrentGatewaySubscription(existing, subscriptionRef)) {
          return { applied: true, conflict: false };
        }

        existing.status = Subscription.Status.CANCELED;
        existing.canceledAt = params.now;

        return this.saveOutcome(existing);
      case 'CHECKOUT_PAID':
      case 'CHECKOUT_EXPIRED':
      case 'CHECKOUT_CANCELED':
        await this.subscriptionRepository.deletePendingCheckout({ accountId, checkoutId: event.checkoutId });

        return { applied: true, conflict: false };
      case 'PAYMENT_CREATED':
        return { applied: true, conflict: false };
    }
  }

  private async saveOutcome(subscription: Subscription, outcome: Omit<BillingEventService.EventOutcome, 'conflict'> = { applied: true }): Promise<BillingEventService.EventOutcome> {
    const saved = await this.subscriptionRepository.save(subscription);

    return { ...outcome, conflict: !saved };
  }

  private async applyPaymentSucceeded({
    event,
    accountId,
    plan,
    subscriptionRef,
    existing,
    now,
    skipCoveredPayment,
  }: BillingEventService.ApplyPaymentSucceededParams): Promise<BillingEventService.EventOutcome> {
    const { dueDate, paymentId } = event;

    if (existing?.reversedPaymentIds?.includes(paymentId)) {
      return { applied: false, conflict: false };
    }

    if (this.isPaymentCovered(existing, dueDate, plan)) {
      return {
        applied: false,
        conflict: false,
        duplicateSubscriptionContext: skipCoveredPayment
          ? undefined
          : this.describeSubscriptionOverActiveYearly(existing, subscriptionRef, now),
      };
    }

    const duplicateSubscriptionContext = this.describeDuplicateMonthlySubscription(existing, subscriptionRef);

    if (!existing) {
      const created = await this.createPaidSubscription({ accountId, paymentId, dueDate, subscriptionRef, plan, now });

      return { applied: true, conflict: !created, duplicateSubscriptionContext };
    }

    existing.appliedPaymentIds = [...(existing.appliedPaymentIds ?? []), paymentId]
      .slice(-BillingEventService.APPLIED_PAYMENT_IDS_LIMIT);

    if (this.isCanceledGatewaySubscription(existing, subscriptionRef)) {
      existing.paidUntil = Subscription.addCycle(dueDate, plan.cycle);

      return this.saveOutcome(existing, { applied: true, duplicateSubscriptionContext });
    }

    const replacedSubscriptionId = duplicateSubscriptionContext ? existing.gatewayRefs?.subscriptionId : undefined;

    this.mergePaymentSucceeded(existing, dueDate, plan, subscriptionRef);
    existing.replacedSubscriptionId = replacedSubscriptionId;

    return this.saveOutcome(existing, { applied: true, duplicateSubscriptionContext });
  }

  private async createPaidSubscription({
    accountId,
    paymentId,
    dueDate,
    subscriptionRef,
    plan,
    now,
  }: BillingEventService.CreatePaidSubscriptionParams): Promise<boolean> {
    const subscription = new Subscription({
      accountId,
      gateway: 'ASAAS',
      status: Subscription.Status.ACTIVE,
      planId: plan.id,
      trialStartedAt: now,
      paidUntil: Subscription.addCycle(dueDate, plan.cycle),
      gatewayRefs: subscriptionRef ? { subscriptionId: subscriptionRef } : undefined,
      appliedPaymentIds: [paymentId],
    });

    try {
      await this.subscriptionRepository.create(subscription);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }

      throw error;
    }

    return true;
  }

  private async applyPaymentReversed({
    event,
    plan,
    subscriptionRef,
    existing,
    now,
    canceledGatewaySubscriptions,
  }: BillingEventService.ApplyPaymentReversedParams): Promise<BillingEventService.EventOutcome> {
    const before = BillingAlertService.describeState(existing);
    const result = this.decideReversal(existing, event, plan, subscriptionRef);

    if (result !== 'REVOKED' || !existing?.paidUntil) {
      return {
        applied: false,
        conflict: false,
        reversal: { result, before, canceledGatewaySubscriptionRef: this.firstOf(canceledGatewaySubscriptions) },
      };
    }

    const gatewaySubscriptionRef = plan.cycle === 'MONTHLY' && existing.status !== Subscription.Status.CANCELED
      ? subscriptionRef
      : undefined;

    if (gatewaySubscriptionRef && !canceledGatewaySubscriptions.has(gatewaySubscriptionRef)) {
      await this.paymentGateway.cancelSubscription({ subscriptionRef: gatewaySubscriptionRef });
      canceledGatewaySubscriptions.add(gatewaySubscriptionRef);
    }

    const paidUntil = this.resolveReversedPaidUntil(existing.paidUntil, event.dueDate, plan);

    existing.paidUntil = paidUntil;
    existing.reversedPaymentIds = [...(existing.reversedPaymentIds ?? []), event.paymentId];

    if (existing.status !== Subscription.Status.CANCELED && (gatewaySubscriptionRef || paidUntil <= now)) {
      existing.status = Subscription.Status.CANCELED;
      existing.canceledAt = now;
    }

    return this.saveOutcome(existing, {
      applied: true,
      reversal: {
        result,
        before,
        after: BillingAlertService.describeState(existing),
        canceledGatewaySubscriptionRef: this.firstOf(canceledGatewaySubscriptions),
      },
    });
  }

  private decideReversal(
    existing: Subscription | null,
    event: BillingAlertService.PaymentReversedEvent,
    plan: BillingEventService.Plan,
    subscriptionRef?: string,
  ): BillingAlertService.ReversalResult {
    if (event.kind !== 'REFUNDED' && event.kind !== 'CHARGEBACK_REQUESTED') {
      return 'ALERT_ONLY';
    }

    if (!event.dueDate || Number.isNaN(new Date(event.dueDate).getTime())) {
      return 'INVALID_PAYLOAD';
    }

    if (!existing?.paidUntil) {
      return 'NO_PAID_SUBSCRIPTION';
    }

    if (existing.reversedPaymentIds?.includes(event.paymentId)) {
      return 'ALREADY_REVERSED';
    }

    if (!this.isCurrentPlanPayment(existing, plan, subscriptionRef)) {
      return 'NOT_CURRENT_PLAN';
    }

    if (existing.appliedPaymentIds && !existing.appliedPaymentIds.includes(event.paymentId)) {
      return 'NOT_APPLIED';
    }

    const toleranceMs = BillingEventService.REVERSAL_PERIOD_TOLERANCE_DAYS * 86_400_000;
    const previousPaidUntil = Subscription.subtractCycle(existing.paidUntil, plan.cycle);

    if (Subscription.addCycle(event.dueDate, plan.cycle).getTime() <= previousPaidUntil.getTime() + toleranceMs) {
      return 'PAST_CYCLE';
    }

    if (existing.replacedSubscriptionId) {
      return 'REPLACED_SUBSCRIPTION';
    }

    return 'REVOKED';
  }

  private resolveReversedPaidUntil(paidUntil: Date, dueDate: string, plan: BillingEventService.Plan): Date {
    const previousPaidUntil = Subscription.subtractCycle(paidUntil, plan.cycle);

    if (plan.cycle !== 'MONTHLY') {
      return previousPaidUntil;
    }

    return new Date(Math.min(previousPaidUntil.getTime(), new Date(dueDate).getTime()));
  }

  private firstOf(values: Set<string>): string | undefined {
    const [first] = values;

    return first;
  }

  private isCurrentPlanPayment(existing: Subscription, plan: BillingEventService.Plan, subscriptionRef?: string): boolean {
    if (existing.planId !== plan.id) {
      return false;
    }

    if (plan.cycle === 'MONTHLY') {
      return Boolean(subscriptionRef) && subscriptionRef === existing.gatewayRefs?.subscriptionId;
    }

    return !subscriptionRef;
  }

  private describeDuplicateMonthlySubscription(existing: Subscription | null, subscriptionRef?: string): string | undefined {
    const currentSubscriptionRef = existing?.gatewayRefs?.subscriptionId;

    if (!existing || !currentSubscriptionRef || currentSubscriptionRef === subscriptionRef) {
      return undefined;
    }

    if (existing.planId !== Subscription.PlanId.PRO_MONTHLY || existing.status === Subscription.Status.CANCELED) {
      return undefined;
    }

    return `assinatura mensal ${currentSubscriptionRef} (${existing.status})`;
  }

  private describeSubscriptionOverActiveYearly(
    existing: Subscription | null,
    subscriptionRef: string | undefined,
    now: Date,
  ): string | undefined {
    if (!existing?.paidUntil || !subscriptionRef || subscriptionRef === existing.gatewayRefs?.subscriptionId) {
      return undefined;
    }

    if (existing.planId !== Subscription.PlanId.PRO_YEARLY || existing.paidUntil <= now) {
      return undefined;
    }

    return `anual ${existing.status} pago até ${existing.paidUntil.toISOString().slice(0, 10)}`;
  }

  private isPaymentCovered(
    existing: Subscription | null,
    dueDate: string,
    plan: BillingEventService.Plan,
  ): boolean {
    return Boolean(existing?.paidUntil && existing.paidUntil >= Subscription.addCycle(dueDate, plan.cycle));
  }

  private isCurrentGatewaySubscription(existing: Subscription, subscriptionRef?: string): boolean {
    const currentSubscriptionRef = existing.gatewayRefs?.subscriptionId;

    return !subscriptionRef || !currentSubscriptionRef || currentSubscriptionRef === subscriptionRef;
  }

  private isCanceledGatewaySubscription(existing: Subscription, subscriptionRef?: string): boolean {
    return existing.status === Subscription.Status.CANCELED
      && Boolean(subscriptionRef)
      && existing.gatewayRefs?.subscriptionId === subscriptionRef;
  }

  private mergePaymentSucceeded(
    subscription: Subscription,
    dueDate: string,
    plan: BillingEventService.Plan,
    subscriptionRef?: string,
  ): void {
    const cyclePaidUntil = Subscription.addCycle(dueDate, plan.cycle);

    subscription.status = Subscription.Status.ACTIVE;
    subscription.planId = plan.id;

    if (!subscription.paidUntil || cyclePaidUntil > subscription.paidUntil) {
      subscription.paidUntil = this.resolveRenewedPaidUntil(subscription.paidUntil, dueDate, plan);
    }

    if (subscriptionRef) {
      subscription.gatewayRefs = { ...subscription.gatewayRefs, subscriptionId: subscriptionRef };
    }
  }

  private resolveRenewedPaidUntil(
    currentPaidUntil: Date | undefined,
    dueDate: string,
    plan: BillingEventService.Plan,
  ): Date {
    const isEarlyYearlyRenewal = plan.cycle === 'YEARLY'
      && Boolean(currentPaidUntil && currentPaidUntil > new Date(dueDate));

    if (!isEarlyYearlyRenewal || !currentPaidUntil) {
      return Subscription.addCycle(dueDate, plan.cycle);
    }

    return Subscription.addCycle(currentPaidUntil, plan.cycle);
  }
}

export namespace BillingEventService {
  export type ApplyOptions = {
    skipCoveredPayment?: boolean;
    skipReversalAlert?: boolean;
    eventTtlDays?: number;
  };

  export type ApplyOutput = {
    handled: boolean;
    applied: boolean;
    duplicate?: boolean;
    accountId?: string;
    reversal?: BillingAlertService.ReversalResult;
  };

  export type Plan = (typeof Subscription.Plan)[Subscription.PlanIdType];

  export type PaymentSucceededEvent = Extract<IPaymentGateway.BillingEvent, { type: 'PAYMENT_SUCCEEDED' }>;

  export type EventOutcome = {
    applied: boolean;
    conflict: boolean;
    duplicateSubscriptionContext?: string;
    reversal?: BillingAlertService.ReversalOutcome;
  };

  export type ApplyToSubscriptionParams = {
    event: IPaymentGateway.BillingEvent;
    accountId: string;
    plan: Plan;
    subscriptionRef?: string;
    skipCoveredPayment: boolean;
  };

  export type ApplyToExistingParams = ApplyToSubscriptionParams & {
    existing: Subscription | null;
    now: Date;
    canceledGatewaySubscriptions: Set<string>;
  };

  export type ApplyPaymentSucceededParams = ApplyToExistingParams & {
    event: PaymentSucceededEvent;
  };

  export type ApplyPaymentReversedParams = ApplyToExistingParams & {
    event: BillingAlertService.PaymentReversedEvent;
  };

  export type CreatePaidSubscriptionParams = {
    accountId: string;
    paymentId: string;
    dueDate: string;
    subscriptionRef?: string;
    plan: Plan;
    now: Date;
  };
}
