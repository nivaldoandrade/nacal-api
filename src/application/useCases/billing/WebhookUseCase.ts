import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { BillingEventService } from '@application/services/BillingEventService';
import { Injectable } from '@kernel/decorators/Injectable';
import { logger } from '@shared/logger/logger';

@Injectable()
export class WebhookUseCase {
  constructor(
    private readonly paymentGateway: IPaymentGateway,
    private readonly billingEventService: BillingEventService,
  ) { }

  async execute({ headers, rawBody }: WebhookUseCase.Input): Promise<WebhookUseCase.Output> {
    const event = await this.paymentGateway.parseWebhook(headers, rawBody);

    if (!event) {
      return { handled: false };
    }

    logger.appendContext({ gatewayEvent: event.gatewayEvent, eventId: event.eventId });

    const { handled, applied, duplicate, accountId, reversal } = await this.billingEventService.apply(event);

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

  private static resolveResult({ handled, applied, duplicate }: Pick<BillingEventService.ApplyOutput, 'handled' | 'applied' | 'duplicate'>) {
    if (duplicate) {
      return 'duplicate';
    }

    if (!handled) {
      return 'unmatched';
    }

    return applied ? 'applied' : 'not_applied';
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
}
