import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { AlertGateway } from '@infra/gateways/AlertGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { logger } from '@shared/logger/logger';

@Injectable()
export class BillingAlertService {
  static readonly ALERTS_GUIDE = 'docs/guide/runbooks/alertas.md';

  static readonly REVERSAL_KIND_LABELS: Record<IPaymentGateway.ReversalKind, string> = {
    REFUNDED: 'estorno total',
    PARTIALLY_REFUNDED: 'estorno parcial',
    CHARGEBACK_REQUESTED: 'chargeback aberto',
    CHARGEBACK_DISPUTE: 'chargeback em disputa',
    CHARGEBACK_REVERSAL_PENDING: 'chargeback ganho',
  };

  constructor(private readonly alertGateway: AlertGateway) { }

  async alertReversal({
    accountId,
    event,
    subscriptionRef,
    reversal,
  }: BillingAlertService.AlertReversalParams): Promise<void> {
    try {
      const { headline, action } = BillingAlertService.describeReversalAlert(reversal.result, event.kind);
      const outcome = reversal.result === 'REVOKED' ? 'Pro descontado' : 'Pro sem mudança';
      const canceledGatewaySubscription = reversal.canceledGatewaySubscriptionRef
        ?? (reversal.result === 'REVOKED' ? 'nenhuma (anual ou já cancelada)' : undefined);

      await this.alertGateway.publish({
        subject: `NaCal: ${BillingAlertService.REVERSAL_KIND_LABELS[event.kind]} · ${outcome}`,
        message: [
          headline,
          '',
          `O que fazer: ${action}`,
          '',
          `Conta: ${accountId}`,
          `Evento: ${BillingAlertService.REVERSAL_KIND_LABELS[event.kind]}`,
          `Pagamento: ${event.paymentId} · vencimento ${event.dueDate} · R$ ${event.amount.toFixed(2)}`,
          `Assinatura do pagamento: ${subscriptionRef ?? 'nenhuma (pagamento avulso, ex.: anual)'}`,
          ...(canceledGatewaySubscription ? [`Assinatura cancelada no Asaas: ${canceledGatewaySubscription}`] : []),
          `Antes: ${reversal.before}`,
          ...(reversal.after ? [`Depois: ${reversal.after}`] : []),
          '',
          `Como agir em cada caso: ${BillingAlertService.ALERTS_GUIDE}#estorno-e-chargeback`,
        ].join('\n'),
      });
    } catch (error) {
      logger.error('payment reversal alert failed', { error });
    }
  }

  async alertDuplicateSubscription({
    accountId,
    context,
    paymentId,
    subscriptionRef,
    dueDate,
    amount,
  }: BillingAlertService.AlertDuplicateSubscriptionParams): Promise<void> {
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
          `Como agir: ${BillingAlertService.ALERTS_GUIDE}#pagamento-de-outra-assinatura-com-o-pro-ativo`,
        ].join('\n'),
      });
    } catch (error) {
      logger.error('duplicate subscription alert failed', { error });
    }
  }

  static describeState(subscription: Subscription | null): string {
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

  private static describeReversalAlert(
    result: BillingAlertService.ReversalResult,
    kind: IPaymentGateway.ReversalKind,
  ): BillingAlertService.ReversalAlertText {
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
        return BillingAlertService.describeAlertOnlyReversal(kind);
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

  private static describeAlertOnlyReversal(kind: IPaymentGateway.ReversalKind): BillingAlertService.ReversalAlertText {
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
}

export namespace BillingAlertService {
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

  export type ReversalOutcome = {
    result: ReversalResult;
    before: string;
    after?: string;
    canceledGatewaySubscriptionRef?: string;
  };

  export type ReversalAlertText = {
    headline: string;
    action: string;
  };

  export type AlertReversalParams = {
    accountId: string;
    event: PaymentReversedEvent;
    subscriptionRef?: string;
    reversal: ReversalOutcome;
  };

  export type AlertDuplicateSubscriptionParams = {
    accountId: string;
    context: string;
    paymentId: string;
    subscriptionRef?: string;
    dueDate: string;
    amount: number;
  };
}
