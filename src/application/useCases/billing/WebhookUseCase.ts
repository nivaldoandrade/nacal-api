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

    const { eventId } = event;

    if (eventId && await this.rateLimitRepository.hasWebhookEvent({ scope: 'webhook-event', key: eventId })) {
      return { handled: true };
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
      return { handled: false };
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

    switch (event.type) {
      case 'PAYMENT_SUCCEEDED':
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
      await this.rateLimitRepository.markWebhookEvent({ scope: 'webhook-event', key: eventId });
    }

    return { handled: true };
  }

  private async applyPaymentSucceeded({
    accountId,
    dueDate,
    subscriptionRef,
    existing,
    plan,
    now,
  }: WebhookUseCase.ApplyPaymentSucceededParams): Promise<void> {
    const cyclePaidUntil = this.addCycle(dueDate, plan);

    if (!existing) {
      const subscription = new Subscription({
        accountId,
        gateway: 'ASAAS',
        status: Subscription.Status.ACTIVE,
        planId: plan.id,
        trialStartedAt: now,
        paidUntil: cyclePaidUntil,
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

        this.mergePaymentSucceeded(winner, cyclePaidUntil, subscriptionRef);
        await this.subscriptionRepository.save(winner);
      }

      return;
    }

    this.mergePaymentSucceeded(existing, cyclePaidUntil, subscriptionRef);
    await this.subscriptionRepository.save(existing);
  }

  private mergePaymentSucceeded(
    subscription: Subscription,
    cyclePaidUntil: Date,
    subscriptionRef?: string,
  ): void {
    subscription.status = Subscription.Status.ACTIVE;

    if (!subscription.paidUntil || cyclePaidUntil > subscription.paidUntil) {
      subscription.paidUntil = cyclePaidUntil;
    }

    if (subscriptionRef) {
      subscription.gatewayRefs = { ...subscription.gatewayRefs, subscriptionId: subscriptionRef };
    }
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

namespace WebhookUseCase {
  export type Input = {
    headers: Record<string, string | undefined>;
    rawBody: string;
  };

  export type Output = {
    handled: boolean;
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
