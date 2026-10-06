import { Subscription } from '@application/entities/Subscription';

export abstract class IPaymentGateway {
  abstract createCustomer(input: IPaymentGateway.CreateCustomerInput): Promise<{ customerId: string }>;
  abstract createCheckout(input: IPaymentGateway.CreateCheckoutInput): Promise<{ checkoutUrl: string; expiresAt: string; checkoutId: string }>;
  abstract cancelSubscription(input: { subscriptionRef: string }): Promise<void>;
  abstract parseWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<IPaymentGateway.BillingEvent | null>;
}

export namespace IPaymentGateway {
  export type CreateCustomerInput = { accountId: string; name: string; email: string };
  export type CreateCheckoutInput = { accountId: string; plan: Subscription.PlanIdType; returnUrl: string };

  export type BillingEvent = { eventId: string; externalReference?: string } & (
    | { type: 'CHECKOUT_PAID'; checkoutId: string; subscriptionRef?: string }
    | { type: 'PAYMENT_CREATED'; paymentId: string; subscriptionRef?: string; checkoutSession?: string }
    | { type: 'PAYMENT_SUCCEEDED'; paymentId: string; subscriptionRef?: string; checkoutSession?: string; dueDate: string; amount: number }
    | { type: 'PAYMENT_OVERDUE'; paymentId: string; subscriptionRef?: string; checkoutSession?: string }
    | { type: 'SUBSCRIPTION_CANCELED'; subscriptionRef?: string }
    | { type: 'CHECKOUT_EXPIRED' | 'CHECKOUT_CANCELED'; checkoutId: string }
  );
}
