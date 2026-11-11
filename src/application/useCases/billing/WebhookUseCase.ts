import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class WebhookUseCase {

  constructor(
    private readonly paymentGateway: IPaymentGateway,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly rateLimitRepository: RateLimitRepository,
  ) { }

  async execute({ headers, rawBody }: WebhookUseCase.Input): Promise<WebhookUseCase.Output> {
    const event = await this.paymentGateway.parseWebhook(headers, rawBody);

    if (!event) {
      return { handled: false };
    }

    const { handled } = await this.applyEvent(event);

    return { handled };
  }

  async applyEvent(
    event: IPaymentGateway.BillingEvent,
    { skipCoveredPayment = false, eventTtlDays }: WebhookUseCase.ApplyEventOptions = {},
  ): Promise<WebhookUseCase.ApplyEventOutput> {
    const { eventId } = event;

    if (eventId && await this.rateLimitRepository.hasWebhookEvent({ scope: 'webhook-event', key: eventId })) {
      return { handled: true, applied: false };
    }

    const subscriptionRef = 'subscriptionRef' in event ? event.subscriptionRef : undefined;
    const checkoutSession = 'checkoutSession' in event ? event.checkoutSession : undefined;

    const ref = event.externalReference?.split('#');
    const gatewayRef = !ref && checkoutSession
      ? await this.subscriptionRepository.findGatewayRef(checkoutSession)
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

    const existing = await this.subscriptionRepository.findByAccountId(accountId);
    const now = new Date();
    let applied = true;

    switch (event.type) {
      case 'PAYMENT_SUCCEEDED':
        if (skipCoveredPayment && this.isPaymentCovered(existing, event.dueDate, plan)) {
          applied = false;
          break;
        }

        if (existing && this.isCanceledGatewaySubscription(existing, subscriptionRef)) {
          await this.extendPaidUntil(existing, this.addCycle(event.dueDate, plan));
          break;
        }

        await this.applyPaymentSucceeded({
          accountId,
          dueDate: event.dueDate,
          subscriptionRef,
          existing,
          plan,
          now,
        });
        break;
      case 'PAYMENT_OVERDUE':
        if (existing && existing.status !== Subscription.Status.CANCELED) {
          existing.status = Subscription.Status.PAST_DUE;
          await this.subscriptionRepository.save(existing);
        }
        break;
      case 'SUBSCRIPTION_CANCELED':
        if (existing && existing.status !== Subscription.Status.CANCELED) {
          existing.status = Subscription.Status.CANCELED;
          existing.canceledAt = now;
          await this.subscriptionRepository.save(existing);
        }
        break;
      case 'CHECKOUT_PAID':
      case 'CHECKOUT_EXPIRED':
      case 'CHECKOUT_CANCELED':
      case 'PAYMENT_CREATED':
        break;
    }

    if (eventId) {
      await this.rateLimitRepository.markWebhookEvent({ scope: 'webhook-event', key: eventId, ttlDays: eventTtlDays });
    }

    return { handled: true, applied, accountId };
  }

  private isPaymentCovered(
    existing: Subscription | null,
    dueDate: string,
    plan: WebhookUseCase.Plan,
  ): boolean {
    return Boolean(existing?.paidUntil && existing.paidUntil >= this.addCycle(dueDate, plan));
  }

  private isCanceledGatewaySubscription(existing: Subscription, subscriptionRef?: string): boolean {
    return existing.status === Subscription.Status.CANCELED
      && Boolean(subscriptionRef)
      && existing.gatewayRefs?.subscriptionId === subscriptionRef;
  }

  private async extendPaidUntil(subscription: Subscription, cyclePaidUntil: Date): Promise<void> {
    if (subscription.paidUntil && cyclePaidUntil <= subscription.paidUntil) {
      return;
    }

    subscription.paidUntil = cyclePaidUntil;
    await this.subscriptionRepository.save(subscription);
  }

  private async applyPaymentSucceeded({
    accountId,
    dueDate,
    subscriptionRef,
    existing,
    plan,
    now,
  }: WebhookUseCase.ApplyPaymentSucceededParams): Promise<void> {
    if (!existing) {
      const subscription = new Subscription({
        accountId,
        gateway: 'ASAAS',
        status: Subscription.Status.ACTIVE,
        planId: plan.id,
        trialStartedAt: now,
        paidUntil: this.addCycle(dueDate, plan),
        gatewayRefs: subscriptionRef ? { subscriptionId: subscriptionRef } : undefined,
      });

      try {
        await this.subscriptionRepository.create(subscription);
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }

        const winner = await this.subscriptionRepository.findByAccountId(accountId);

        if (!winner) {
          throw error;
        }

        this.mergePaymentSucceeded(winner, dueDate, plan, subscriptionRef);
        await this.subscriptionRepository.save(winner);
      }

      return;
    }

    this.mergePaymentSucceeded(existing, dueDate, plan, subscriptionRef);
    await this.subscriptionRepository.save(existing);
  }

  private mergePaymentSucceeded(
    subscription: Subscription,
    dueDate: string,
    plan: WebhookUseCase.Plan,
    subscriptionRef?: string,
  ): void {
    const cyclePaidUntil = this.addCycle(dueDate, plan);

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
    plan: WebhookUseCase.Plan,
  ): Date {
    const isEarlyYearlyRenewal = plan.cycle === 'YEARLY'
      && Boolean(currentPaidUntil && currentPaidUntil > new Date(dueDate));

    if (!isEarlyYearlyRenewal || !currentPaidUntil) {
      return this.addCycle(dueDate, plan);
    }

    return this.addCycle(currentPaidUntil.toISOString(), plan);
  }

  private addCycle(dueDate: string, plan: WebhookUseCase.Plan): Date {
    const date = new Date(dueDate);

    if (plan.cycle === 'MONTHLY') {
      date.setUTCMonth(date.getUTCMonth() + 1);
    } else {
      date.setUTCFullYear(date.getUTCFullYear() + 1);
    }

    return date;
  }
}

export namespace WebhookUseCase {
  export type Input = {
    headers: Record<string, string | undefined>;
    rawBody: string;
  };

  export type Output = {
    handled: boolean;
  };

  export type ApplyEventOptions = {
    skipCoveredPayment?: boolean;
    eventTtlDays?: number;
  };

  export type ApplyEventOutput = {
    handled: boolean;
    applied: boolean;
    accountId?: string;
  };

  export type Plan = (typeof Subscription.Plan)[Subscription.PlanIdType];

  export type ApplyPaymentSucceededParams = {
    accountId: string;
    dueDate: string;
    subscriptionRef?: string;
    existing: Subscription | null;
    plan: Plan;
    now: Date;
  };
}
