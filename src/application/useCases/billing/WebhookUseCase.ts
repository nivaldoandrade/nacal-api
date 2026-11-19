import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { AlertGateway } from '@infra/gateways/AlertGateway';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Injectable } from '@kernel/decorators/Injectable';
import { logger } from '@shared/logger/logger';

@Injectable()
export class WebhookUseCase {
  static readonly APPLIED_PAYMENT_IDS_LIMIT = 24;

  static readonly REVERSAL_PERIOD_TOLERANCE_DAYS = 7;

  static readonly REVERSAL_KIND_LABELS: Record<IPaymentGateway.ReversalKind, string> = {
    REFUNDED: 'estorno total',
    PARTIALLY_REFUNDED: 'estorno parcial',
    CHARGEBACK_REQUESTED: 'chargeback aberto',
    CHARGEBACK_DISPUTE: 'chargeback em disputa',
    CHARGEBACK_REVERSAL_PENDING: 'chargeback ganho',
  };

  static readonly ALERTS_GUIDE = 'docs/guide/runbooks/alertas.md';

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

    logger.appendContext({ gatewayEvent: event.gatewayEvent, eventId: event.eventId });

    const { handled, applied, duplicate, accountId, reversal } = await this.applyEvent(event);

    logger.info('billing webhook', {
      gatewayEvent: event.gatewayEvent,
      type: event.type,
      eventId: event.eventId,
      paymentId: 'paymentId' in event ? event.paymentId : undefined,
      subscriptionRef: 'subscriptionRef' in event ? event.subscriptionRef : undefined,
      checkoutId: 'checkoutId' in event ? event.checkoutId : undefined,
      checkoutSession: 'checkoutSession' in event ? event.checkoutSession : undefined,
      externalReference: event.externalReference,
      accountId,
      result: WebhookUseCase.resolveResult({ handled, applied, duplicate }),
      reversal,
    });

    return { handled };
  }

  private static resolveResult({ handled, applied, duplicate }: Pick<WebhookUseCase.ApplyEventOutput, 'handled' | 'applied' | 'duplicate'>) {
    if (duplicate) {
      return 'duplicate';
    }

    if (!handled) {
      return 'unmatched';
    }

    return applied ? 'applied' : 'not_applied';
  }

  async applyEvent(
    event: IPaymentGateway.BillingEvent,
    { skipCoveredPayment = false, skipReversalAlert = false, eventTtlDays }: WebhookUseCase.ApplyEventOptions = {},
  ): Promise<WebhookUseCase.ApplyEventOutput> {
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
      await this.alertDuplicateSubscription({
        accountId,
        context: outcome.duplicateSubscriptionContext,
        paymentId: event.paymentId,
        subscriptionRef,
        dueDate: event.dueDate,
        amount: event.amount,
      });
    }

    if (outcome.reversal && event.type === 'PAYMENT_REVERSED' && !skipReversalAlert) {
      await this.alertReversal({ accountId, event, subscriptionRef, reversal: outcome.reversal });
    }

    return { handled: true, applied: outcome.applied, accountId, reversal: outcome.reversal?.result };
  }

  private async applyToSubscription(params: WebhookUseCase.ApplyToSubscriptionParams): Promise<WebhookUseCase.EventOutcome> {
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

  private async applyToExisting(params: WebhookUseCase.ApplyToExistingParams): Promise<WebhookUseCase.EventOutcome> {
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

  private async saveOutcome(subscription: Subscription, outcome: Omit<WebhookUseCase.EventOutcome, 'conflict'> = { applied: true }): Promise<WebhookUseCase.EventOutcome> {
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
  }: WebhookUseCase.ApplyPaymentSucceededParams): Promise<WebhookUseCase.EventOutcome> {
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
      .slice(-WebhookUseCase.APPLIED_PAYMENT_IDS_LIMIT);

    if (this.isCanceledGatewaySubscription(existing, subscriptionRef)) {
      existing.paidUntil = this.addCycle(dueDate, plan);

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
  }: WebhookUseCase.CreatePaidSubscriptionParams): Promise<boolean> {
    const subscription = new Subscription({
      accountId,
      gateway: 'ASAAS',
      status: Subscription.Status.ACTIVE,
      planId: plan.id,
      trialStartedAt: now,
      paidUntil: this.addCycle(dueDate, plan),
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
  }: WebhookUseCase.ApplyPaymentReversedParams): Promise<WebhookUseCase.EventOutcome> {
    const before = this.describeState(existing);
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
        after: this.describeState(existing),
        canceledGatewaySubscriptionRef: this.firstOf(canceledGatewaySubscriptions),
      },
    });
  }

  private decideReversal(
    existing: Subscription | null,
    event: WebhookUseCase.PaymentReversedEvent,
    plan: WebhookUseCase.Plan,
    subscriptionRef?: string,
  ): WebhookUseCase.ReversalResult {
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

    const toleranceMs = WebhookUseCase.REVERSAL_PERIOD_TOLERANCE_DAYS * 86_400_000;
    const previousPaidUntil = this.subtractCycle(existing.paidUntil, plan);

    if (this.addCycle(event.dueDate, plan).getTime() <= previousPaidUntil.getTime() + toleranceMs) {
      return 'PAST_CYCLE';
    }

    if (existing.replacedSubscriptionId) {
      return 'REPLACED_SUBSCRIPTION';
    }

    return 'REVOKED';
  }

  private resolveReversedPaidUntil(paidUntil: Date, dueDate: string, plan: WebhookUseCase.Plan): Date {
    const previousPaidUntil = this.subtractCycle(paidUntil, plan);

    if (plan.cycle !== 'MONTHLY') {
      return previousPaidUntil;
    }

    return new Date(Math.min(previousPaidUntil.getTime(), new Date(dueDate).getTime()));
  }

  private firstOf(values: Set<string>): string | undefined {
    const [first] = values;

    return first;
  }

  private isCurrentPlanPayment(existing: Subscription, plan: WebhookUseCase.Plan, subscriptionRef?: string): boolean {
    if (existing.planId !== plan.id) {
      return false;
    }

    if (plan.cycle === 'MONTHLY') {
      return Boolean(subscriptionRef) && subscriptionRef === existing.gatewayRefs?.subscriptionId;
    }

    return !subscriptionRef;
  }

  private describeState(subscription: Subscription | null): string {
    if (!subscription) {
      return 'sem assinatura';
    }

    const paidUntil = subscription.paidUntil
      ? `pago até ${subscription.paidUntil.toISOString().slice(0, 10)}`
      : 'sem pagamento';

    const gatewaySubscription = subscription.gatewayRefs?.subscriptionId
      ? `, assinatura do Asaas ${subscription.gatewayRefs.subscriptionId}`
      : '';

    return `${subscription.planId} ${subscription.status}, ${paidUntil}${gatewaySubscription}`;
  }

  private describeReversalAlert(
    result: WebhookUseCase.ReversalResult,
    kind: IPaymentGateway.ReversalKind,
  ): WebhookUseCase.ReversalAlertText {
    switch (result) {
      case 'REVOKED':
        if (kind === 'CHARGEBACK_REQUESTED') {
          return {
            headline: 'Chargeback aberto: o ciclo pago por esse pagamento foi descontado do Pro da conta.',
            action: 'Se quiser contestar, envie os documentos da disputa pelo painel do Asaas dentro do prazo. Se ganhar, o Pro não volta sozinho: ajuste a conta à mão.',
          };
        }

        return {
          headline: 'Estorno total: o ciclo pago por esse pagamento foi descontado do Pro da conta.',
          action: 'Nada a fazer se o estorno foi feito por você. Se não foi, confira no painel do Asaas quem estornou.',
        };
      case 'ALERT_ONLY':
        return this.describeAlertOnlyReversal(kind);
      case 'INVALID_PAYLOAD':
        return {
          headline: 'O evento chegou sem data de vencimento válida, então o Pro da conta continua como está.',
          action: 'Confira o pagamento no painel do Asaas. Se o Pro devia ter sido descontado, ajuste a conta à mão.',
        };
      case 'NO_PAID_SUBSCRIPTION':
        return {
          headline: 'A conta não tem assinatura paga, então nada mudou.',
          action: 'Confira no painel do Asaas se o pagamento é mesmo dessa conta.',
        };
      case 'ALREADY_REVERSED':
        return {
          headline: 'Esse pagamento já tinha sido descontado por um evento anterior (do mesmo estorno ou chargeback). Nada mudou.',
          action: 'Nada a fazer.',
        };
      case 'NOT_CURRENT_PLAN':
        return {
          headline: 'O pagamento não é do plano atual da conta (é de outra assinatura do Asaas ou de outro plano). O Pro continua como está.',
          action: 'Confira no painel do Asaas se essa outra assinatura ainda cobra e cancele-a se sobrou.',
        };
      case 'PAST_CYCLE':
        return {
          headline: 'O pagamento é de um ciclo que já passou. O Pro atual continua como está.',
          action: 'Nada a fazer, a não ser que o estorno devesse encerrar o Pro atual: aí ajuste a conta à mão.',
        };
      case 'NOT_APPLIED':
        return {
          headline: 'Esse pagamento não mudou o Pro quando foi confirmado (o período já estava coberto, ex.: pagamento em dobro). O Pro continua como está.',
          action: 'Nada a fazer se você estornou um pagamento em dobro. Confira no painel do Asaas que o outro pagamento continua pago.',
        };
      case 'REPLACED_SUBSCRIPTION':
        return {
          headline: 'A assinatura desse pagamento entrou no lugar de outra que ainda estava ativa (cobrança em dobro). O Pro continua como está.',
          action: 'No painel do Asaas, cancele a assinatura que sobrou e, se precisar, ajuste a conta à mão.',
        };
    }
  }

  private describeAlertOnlyReversal(kind: IPaymentGateway.ReversalKind): WebhookUseCase.ReversalAlertText {
    switch (kind) {
      case 'PARTIALLY_REFUNDED':
        return {
          headline: 'Estorno parcial: o Pro da conta continua como está.',
          action: 'Nada a fazer se foi um desconto ou uma compensação. Se a intenção era encerrar o Pro (ex.: devolução proporcional do anual), faça o estorno total ou ajuste a conta à mão.',
        };
      case 'CHARGEBACK_DISPUTE':
        return {
          headline: 'Chargeback em disputa: nada mudou na conta agora. O Pro é descontado quando o chargeback é aberto (confira o estado abaixo).',
          action: 'Acompanhe a disputa no painel do Asaas.',
        };
      case 'CHARGEBACK_REVERSAL_PENDING':
        return {
          headline: 'Disputa do chargeback ganha: falta só a adquirente devolver o valor. O Pro não volta sozinho.',
          action: 'Se quiser devolver o Pro ao usuário, ajuste a conta à mão.',
        };
      case 'REFUNDED':
      case 'CHARGEBACK_REQUESTED':
        return {
          headline: 'Nada mudou na conta.',
          action: 'Confira o pagamento no painel do Asaas.',
        };
    }
  }

  private async alertReversal({
    accountId,
    event,
    subscriptionRef,
    reversal,
  }: WebhookUseCase.AlertReversalParams): Promise<void> {
    try {
      const { headline, action } = this.describeReversalAlert(reversal.result, event.kind);
      const outcome = reversal.result === 'REVOKED' ? 'Pro descontado' : 'Pro sem mudança';
      const canceledGatewaySubscription = reversal.canceledGatewaySubscriptionRef
        ?? (reversal.result === 'REVOKED' ? 'nenhuma (anual ou já cancelada)' : undefined);

      await this.alertGateway.publish({
        subject: `NaCal: ${WebhookUseCase.REVERSAL_KIND_LABELS[event.kind]} · ${outcome}`,
        message: [
          headline,
          '',
          `O que fazer: ${action}`,
          '',
          `Conta: ${accountId}`,
          `Evento: ${WebhookUseCase.REVERSAL_KIND_LABELS[event.kind]}`,
          `Pagamento: ${event.paymentId} · vencimento ${event.dueDate} · R$ ${event.amount.toFixed(2)}`,
          `Assinatura do pagamento: ${subscriptionRef ?? 'nenhuma (pagamento avulso, ex.: anual)'}`,
          ...(canceledGatewaySubscription ? [`Assinatura cancelada no Asaas: ${canceledGatewaySubscription}`] : []),
          `Antes: ${reversal.before}`,
          ...(reversal.after ? [`Depois: ${reversal.after}`] : []),
          '',
          `Como agir em cada caso: ${WebhookUseCase.ALERTS_GUIDE}#estorno-e-chargeback`,
        ].join('\n'),
      });
    } catch (error) {
      logger.error('payment reversal alert failed', { error });
    }
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
          'Chegou um pagamento confirmado que não é da assinatura guardada, com o Pro dela ainda ativo. A conta pode estar com duas cobranças ativas no Asaas.',
          '',
          'O que fazer: confira no painel do Asaas, cancele a assinatura que sobrou e estorne a cobrança em dobro, se houver.',
          '',
          `Conta: ${accountId}`,
          `Situação guardada antes do pagamento: ${context}`,
          `Assinatura do pagamento: ${subscriptionRef ?? 'nenhuma (pagamento avulso, ex.: anual)'}`,
          `Pagamento: ${paymentId} · vencimento ${dueDate} · R$ ${amount.toFixed(2)}`,
          '',
          `Como agir: ${WebhookUseCase.ALERTS_GUIDE}#pagamento-de-outra-assinatura-com-o-pro-ativo`,
        ].join('\n'),
      });
    } catch (error) {
      logger.error('duplicate subscription alert failed', { error });
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

  private subtractCycle(paidUntil: Date, plan: WebhookUseCase.Plan): Date {
    const date = new Date(paidUntil);

    if (plan.cycle === 'MONTHLY') {
      date.setUTCMonth(date.getUTCMonth() - 1);
    } else {
      date.setUTCFullYear(date.getUTCFullYear() - 1);
    }

    return date;
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
    skipReversalAlert?: boolean;
    eventTtlDays?: number;
  };

  export type ApplyEventOutput = {
    handled: boolean;
    applied: boolean;
    duplicate?: boolean;
    accountId?: string;
    reversal?: ReversalResult;
  };

  export type Plan = (typeof Subscription.Plan)[Subscription.PlanIdType];

  export type PaymentSucceededEvent = Extract<IPaymentGateway.BillingEvent, { type: 'PAYMENT_SUCCEEDED' }>;

  export type PaymentReversedEvent = Extract<IPaymentGateway.BillingEvent, { type: 'PAYMENT_REVERSED' }>;

  export type ReversalResult =
    | 'REVOKED'
    | 'ALERT_ONLY'
    | 'INVALID_PAYLOAD'
    | 'NO_PAID_SUBSCRIPTION'
    | 'ALREADY_REVERSED'
    | 'NOT_CURRENT_PLAN'
    | 'PAST_CYCLE'
    | 'NOT_APPLIED'
    | 'REPLACED_SUBSCRIPTION';

  export type ReversalAlertText = {
    headline: string;
    action: string;
  };

  export type ReversalOutcome = {
    result: ReversalResult;
    before: string;
    after?: string;
    canceledGatewaySubscriptionRef?: string;
  };

  export type EventOutcome = {
    applied: boolean;
    conflict: boolean;
    duplicateSubscriptionContext?: string;
    reversal?: ReversalOutcome;
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
    event: PaymentReversedEvent;
  };

  export type CreatePaidSubscriptionParams = {
    accountId: string;
    paymentId: string;
    dueDate: string;
    subscriptionRef?: string;
    plan: Plan;
    now: Date;
  };

  export type AlertDuplicateSubscriptionParams = {
    accountId: string;
    context: string;
    paymentId: string;
    subscriptionRef?: string;
    dueDate: string;
    amount: number;
  };

  export type AlertReversalParams = {
    accountId: string;
    event: PaymentReversedEvent;
    subscriptionRef?: string;
    reversal: ReversalOutcome;
  };
}
