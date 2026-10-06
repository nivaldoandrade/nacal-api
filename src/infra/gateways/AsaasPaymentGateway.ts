import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { BillingError } from '@application/errors/application/BillingError';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class AsaasPaymentGateway extends IPaymentGateway {

  constructor(private readonly config: AppConfig) {
    super();
  }

  async createCustomer({ accountId, email, name }: IPaymentGateway.CreateCustomerInput): Promise<{ customerId: string; }> {
    const response = await this.request<AsaasPaymentGateway.RequestCustomersResponse>('/v3/customers', {
      method: 'POST',
      body: {
        name,
        email,
        externalReference: accountId,
      },
    });

    return {
      customerId: response.id,
    };

  }

  async createCheckout({
    accountId,
    plan,
    returnUrl,
  }: IPaymentGateway.CreateCheckoutInput): Promise<{ checkoutUrl: string; expiresAt: string; checkoutId: string; }> {
    const planInfo = Subscription.Plan[plan];
    const isRecurrent = planInfo.cycle === 'MONTHLY';

    const minutesToExpire = 60;

    const response = await this.request<AsaasPaymentGateway.RequestCheckoutResponse>('/v3/checkouts', {
      method: 'POST',
      body: {
        billingTypes: isRecurrent ? ['CREDIT_CARD'] : ['PIX', 'CREDIT_CARD'],
        chargeTypes: isRecurrent ? ['RECURRENT'] : ['DETACHED'],
        ...(isRecurrent && {
          subscription: {
            cycle: planInfo.cycle,
            nextDueDate: new Date().toISOString().slice(0, 10),
          },
        }),
        externalReference: `${accountId}#${plan}`,
        callback: {
          successUrl: returnUrl,
          cancelUrl: returnUrl,
          expiredUrl: returnUrl,
        },
        minutesToExpire,
        items: [{
          name: 'NaCal Pro',
          quantity: 1,
          value: planInfo.priceCents / 100,
        }],
      },
    });

    return {
      checkoutId: response.id,
      checkoutUrl: response.link,
      expiresAt: new Date(Date.now() + minutesToExpire * 60_000).toISOString(),
    };

  }

  async cancelSubscription({ subscriptionRef }: AsaasPaymentGateway.CancelSubscriptionParams): Promise<void> {
    await this.request(`/v3/subscriptions/${subscriptionRef}`, { method: 'DELETE' });
  }

  async parseWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<IPaymentGateway.BillingEvent | null> {
    if (headers['asaas-access-token'] !== this.config.billing.asaas.webhookToken) {
      throw new BillingError('Invalid webhook token.');
    }

    const payload = JSON.parse(rawBody) as AsaasPaymentGateway.WebhookPayload;

    const base = {
      eventId: payload.id,
      externalReference:
        payload.payment?.externalReference
        ?? payload.checkout?.externalReference
        ?? payload.subscription?.externalReference,
    };

    switch (payload.event) {
      case 'CHECKOUT_PAID':
        return { ...base, type: 'CHECKOUT_PAID', checkoutId: payload.checkout?.id ?? '' };
      case 'CHECKOUT_CANCELED':
        return { ...base, type: 'CHECKOUT_CANCELED', checkoutId: payload.checkout?.id ?? '' };
      case 'CHECKOUT_EXPIRED':
        return { ...base, type: 'CHECKOUT_EXPIRED', checkoutId: payload.checkout?.id ?? '' };
      case 'PAYMENT_CREATED':
        return { ...base, type: 'PAYMENT_CREATED', paymentId: payload.payment?.id ?? '', subscriptionRef: payload.payment?.subscription, checkoutSession: payload.payment?.checkoutSession };
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED':
        return {
          ...base,
          type: 'PAYMENT_SUCCEEDED',
          paymentId: payload.payment?.id ?? '',
          subscriptionRef: payload.payment?.subscription,
          checkoutSession: payload.payment?.checkoutSession,
          dueDate: payload.payment?.dueDate ?? '',
          amount: payload.payment?.value ?? 0,
        };
      case 'PAYMENT_OVERDUE':
        return { ...base, type: 'PAYMENT_OVERDUE', paymentId: payload.payment?.id ?? '', subscriptionRef: payload.payment?.subscription, checkoutSession: payload.payment?.checkoutSession };
      case 'SUBSCRIPTION_CANCELED':
      case 'SUBSCRIPTION_DELETED':
        return { ...base, type: 'SUBSCRIPTION_CANCELED', subscriptionRef: payload.subscription?.id };
      default:
        return null;
    }
  }

  private async request<T>(path: string, init?: Omit<RequestInit, 'body'> & { body?: unknown }): Promise<T> {
    const response = await fetch(`${this.config.billing.asaas.baseUrl}${path}`, {
      ...init,
      headers: {
        access_token: this.config.billing.asaas.apiKey,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const erroBody = (await response.json().catch(() => null)) as {
        errors?: Array<{ code?: string; description?: string }>
      };

      throw new BillingError(erroBody?.errors?.[0]?.description);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

export namespace AsaasPaymentGateway {
  export type RequestCustomersResponse = {
    id: string;
  };

  export type RequestCheckoutResponse = {
    id: string;
    link: string;
    status: string;
  }

  export type CancelSubscriptionParams = {
    subscriptionRef: string;
  }

  export type WebhookPayload = {
    id: string;
    event: string;
    payment?: { id: string; subscription?: string; dueDate?: string; value?: number; externalReference?: string; checkoutSession?: string };
    subscription?: { id: string; externalReference?: string };
    checkout?: { id: string; externalReference?: string };
  };
}
