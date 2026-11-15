import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { AlertGateway } from '@infra/gateways/AlertGateway';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class WebhookUseCase {

  constructor(
    private readonly paymentGateway: IPaymentGateway,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly rateLimitRepository: RateLimitRepository,
    private readonly alertGateway: AlertGateway,
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

    const existing = await this.subscriptionRepository.findByAccountId(accountId);
    const now = new Date();
    let applied = true;
    let duplicateSubscriptionContext: string | undefined;

    switch (event.type) {
      case 'PAYMENT_SUCCEEDED':
        if (this.isPaymentCovered(existing, event.dueDate, plan)) {
          applied = false;
          duplicateSubscriptionContext = skipCoveredPayment
            ? undefined
            : this.describeSubscriptionOverActiveYearly(existing, subscriptionRef, now);
          break;
        }

        duplicateSubscriptionContext = this.describeDuplicateMonthlySubscription(existing, subscriptionRef);

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
        if (existing && existing.status !== Subscription.Status.CANCELED && this.isCurrentGatewaySubscription(existing, subscriptionRef)) {
          existing.status = Subscription.Status.PAST_DUE;
          await this.subscriptionRepository.save(existing);
        }
        break;
      case 'SUBSCRIPTION_CANCELED':
        if (existing && existing.status !== Subscription.Status.CANCELED && this.isCurrentGatewaySubscription(existing, subscriptionRef)) {
          existing.status = Subscription.Status.CANCELED;
          existing.canceledAt = now;
          await this.subscriptionRepository.save(existing);
        }
        break;
      case 'CHECKOUT_PAID':
      case 'CHECKOUT_EXPIRED':
      case 'CHECKOUT_CANCELED':
        await this.subscriptionRepository.deletePendingCheckout({ accountId, checkoutId: event.checkoutId });
        break;
      case 'PAYMENT_CREATED':
        break;
    }

    if (eventId) {
      await this.rateLimitRepository.markWebhookEvent({ scope: 'webhook-event', key: eventId, ttlDays: eventTtlDays });
    }

    if (duplicateSubscriptionContext && event.type === 'PAYMENT_SUCCEEDED') {
      await this.alertDuplicateSubscription({
        accountId,
        context: duplicateSubscriptionContext,
        paymentId: event.paymentId,
        subscriptionRef,
        dueDate: event.dueDate,
        amount: event.amount,
      });
    }

    return { handled: true, applied, accountId };
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

  private async alertDuplicateSubscription({
    accountId,
    context,
    paymentId,
    subscriptionRef,
    dueDate,
    amount,
  }: WebhookUseCase.AlertDuplicateSubscriptionParams): Promise<void> {
    try {
      await this.alertGateway.publish({
        subject: 'NaCal: pagamento de outra assinatura com o Pro ativo',
        message: [
          'Chegou um pagamento confirmado que não é da assinatura guardada, com o Pro dela ainda ativo.',
          'A conta pode estar com duas cobranças ativas no Asaas. Conferir no painel e cancelar a que sobrou.',
          '',
          `Conta: ${accountId}`,
          `Situação guardada antes do pagamento: ${context}`,
          `Assinatura do pagamento: ${subscriptionRef ?? 'nenhuma (pagamento avulso, ex.: anual)'}`,
          `Pagamento: ${paymentId} · vencimento ${dueDate} · R$ ${amount.toFixed(2)}`,
        ].join('\n'),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[alert] duplicate subscription alert failed', error);
    }
  }

  private isPaymentCovered(
    existing: Subscription | null,
    dueDate: string,
    plan: WebhookUseCase.Plan,
  ): boolean {
    return Boolean(existing?.paidUntil && existing.paidUntil >= this.addCycle(dueDate, plan));
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

  export type AlertDuplicateSubscriptionParams = {
    accountId: string;
    context: string;
    paymentId: string;
    subscriptionRef?: string;
    dueDate: string;
    amount: number;
  };

  export type ApplyPaymentSucceededParams = {
    accountId: string;
    dueDate: string;
    subscriptionRef?: string;
    existing: Subscription | null;
    plan: Plan;
    now: Date;
  };
}
