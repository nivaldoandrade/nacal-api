import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { WebhookUseCase } from '@application/useCases/billing/WebhookUseCase';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { AlertGateway } from '@infra/gateways/AlertGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ReconcilePaymentsUseCase {
  static readonly DEFAULT_LOOKBACK_DAYS = 35;

  static readonly MAX_LOOKBACK_DAYS = 365;

  static readonly MARKER_TTL_MARGIN_DAYS = 10;

  constructor(
    private readonly paymentGateway: IPaymentGateway,
    private readonly webhookUseCase: WebhookUseCase,
    private readonly rateLimitRepository: RateLimitRepository,
    private readonly alertGateway: AlertGateway,
  ) { }

  async execute({
    lookbackDays = ReconcilePaymentsUseCase.DEFAULT_LOOKBACK_DAYS,
  }: ReconcilePaymentsUseCase.Input = {}): Promise<ReconcilePaymentsUseCase.Output> {
    const markerTtlDays = lookbackDays + ReconcilePaymentsUseCase.MARKER_TTL_MARGIN_DAYS;
    const dueDateFrom = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

    const payments = await this.paymentGateway.listPaidPayments({ dueDateFrom });
    payments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const output: ReconcilePaymentsUseCase.Output = {
      dueDateFrom,
      checked: payments.length,
      activated: [],
      unmatched: [],
      failed: [],
    };

    for (const payment of payments) {
      try {
        await this.reconcilePayment(payment, markerTtlDays, output);
      } catch (error) {
        output.failed.push({ paymentId: payment.paymentId, error: this.describeError(error) });
      }
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ message: 'billing reconciliation', ...output }));

    if (output.activated.length || output.unmatched.length || output.failed.length) {
      await this.alert('reconciliação de pagamentos encontrou divergências', [
        `Pagamentos verificados: ${output.checked} (vencimento a partir de ${dueDateFrom}).`,
        '',
        `Ativados pela reconciliação (o webhook não ativou): ${output.activated.length}`,
        ...output.activated.map((item) => `- ${item.paymentId} · vencimento ${item.dueDate} · conta ${item.accountId}`),
        '',
        `Pagos sem conta correspondente (conferir no painel): ${output.unmatched.length}`,
        ...output.unmatched.map((item) => `- ${item.paymentId} · vencimento ${item.dueDate}`),
        '',
        `Com erro (serão tentados de novo na próxima execução): ${output.failed.length}`,
        ...output.failed.map((item) => `- ${item.paymentId} · ${item.error}`),
      ]);
    }

    return output;
  }

  private async reconcilePayment(
    payment: IPaymentGateway.PaidPayment,
    markerTtlDays: number,
    output: ReconcilePaymentsUseCase.Output,
  ): Promise<void> {
    const eventId = `reconcile-payment#${payment.paymentId}`;

    const { handled, applied, accountId } = await this.webhookUseCase.applyEvent({
      type: 'PAYMENT_SUCCEEDED',
      eventId,
      externalReference: payment.externalReference,
      paymentId: payment.paymentId,
      subscriptionRef: payment.subscriptionRef,
      checkoutSession: payment.checkoutSession,
      dueDate: payment.dueDate,
      amount: payment.amount,
    }, { skipCoveredPayment: true, keepCanceledSubscription: true, eventTtlDays: markerTtlDays });

    if (!handled) {
      await this.rateLimitRepository.markWebhookEvent({ scope: 'webhook-event', key: eventId, ttlDays: markerTtlDays });
      output.unmatched.push({ paymentId: payment.paymentId, dueDate: payment.dueDate });

      return;
    }

    if (applied && accountId) {
      output.activated.push({ paymentId: payment.paymentId, dueDate: payment.dueDate, accountId });
    }
  }

  private async alert(subject: string, lines: string[]): Promise<void> {
    await this.alertGateway.publish({
      subject: `NaCal: ${subject}`,
      message: lines.join('\n'),
    });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export namespace ReconcilePaymentsUseCase {
  export type Input = {
    lookbackDays?: number;
  };

  export type Output = {
    dueDateFrom: string;
    checked: number;
    activated: Array<{ paymentId: string; dueDate: string; accountId: string }>;
    unmatched: Array<{ paymentId: string; dueDate: string }>;
    failed: Array<{ paymentId: string; error: string }>;
  };
}
