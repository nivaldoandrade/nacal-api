import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { SubscriptionAlreadyActive } from '@application/errors/application/SubscriptionAlreadyActive';
import { BadRequest } from '@application/errors/http/BadRequest';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class CreateCheckoutUseCase {
  static readonly YEARLY_RENEWAL_WINDOW_DAYS = 31;

  static readonly PENDING_CHECKOUT_MIN_REMAINING_MS = 10 * 60_000;

  constructor(
    private readonly paymentGateway: IPaymentGateway,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly config: AppConfig,
  ) { }

  async execute({ accountId, planId, returnUrl }: CreateCheckoutUseCase.Input): Promise<CreateCheckoutUseCase.Output> {
    const plan = Subscription.Plan[planId];

    if (!plan) {
      throw new BadRequest('Invalid plan.');
    }

    const appWebUrl = this.normalizeUrl(this.config.billing.appWebUrl);
    const normalizedReturnUrl = this.normalizeUrl(returnUrl);
    const isValidReturn = normalizedReturnUrl === appWebUrl
      || normalizedReturnUrl.startsWith(`${appWebUrl}/`)
      || returnUrl.startsWith('nacal://');

    if (!isValidReturn) {
      throw new BadRequest('Invalid returnUrl.');
    }

    const now = new Date();
    const subscription = await this.subscriptionRepository.findByAccountId(accountId);
    const invoice = await this.resolveCurrentSubscription(subscription, planId, now);

    if (invoice) {
      return invoice;
    }

    const pendingCheckout = await this.subscriptionRepository.findPendingCheckout(accountId);

    if (pendingCheckout && this.canReusePendingCheckout(pendingCheckout, planId, returnUrl, now)) {
      return {
        checkoutUrl: pendingCheckout.checkoutUrl,
        expiresAt: pendingCheckout.checkoutExpiresAt.toISOString(),
        type: 'CHECKOUT',
      };
    }

    const { checkoutId, checkoutUrl, expiresAt } = await this.paymentGateway.createCheckout({
      accountId,
      plan: planId,
      returnUrl,
    });

    await this.subscriptionRepository.linkGatewayRef({
      gatewayId: checkoutId,
      accountId,
      planId,
    });

    await this.subscriptionRepository.savePendingCheckout({
      accountId,
      planId,
      returnUrl,
      checkoutId,
      checkoutUrl,
      checkoutExpiresAt: new Date(expiresAt),
    });

    return { checkoutUrl, expiresAt, type: 'CHECKOUT' };
  }

  private async resolveCurrentSubscription(
    subscription: Subscription | null,
    planId: Subscription.PlanIdType,
    now: Date,
  ): Promise<CreateCheckoutUseCase.Output | null> {
    if (!subscription) {
      return null;
    }

    const isPaidStatus = subscription.status === Subscription.Status.ACTIVE
      || subscription.status === Subscription.Status.PAST_DUE;

    if (!isPaidStatus) {
      return null;
    }

    const subscriptionRef = subscription.gatewayRefs?.subscriptionId;

    if (subscription.planId === Subscription.PlanId.PRO_MONTHLY && subscriptionRef) {
      return this.resolveMonthlySubscription(subscription, subscriptionRef, planId, now);
    }

    this.assertCanBuyWithoutGatewaySubscription(subscription, planId, now);

    return null;
  }

  private async resolveMonthlySubscription(
    subscription: Subscription,
    subscriptionRef: string,
    planId: Subscription.PlanIdType,
    now: Date,
  ): Promise<CreateCheckoutUseCase.Output | null> {
    const isPro = Subscription.resolveEffectivePlan(subscription, now) === 'PRO';

    if (!isPro) {
      await this.paymentGateway.cancelSubscription({ subscriptionRef });

      subscription.status = Subscription.Status.CANCELED;
      subscription.canceledAt = now;
      await this.subscriptionRepository.save(subscription);

      return null;
    }

    if (subscription.status === Subscription.Status.ACTIVE || planId !== Subscription.PlanId.PRO_MONTHLY) {
      throw new SubscriptionAlreadyActive();
    }

    const openPayment = await this.paymentGateway.findOpenSubscriptionPayment({ subscriptionRef });

    if (!openPayment) {
      throw new SubscriptionAlreadyActive('No open payment for the current subscription.');
    }

    return {
      checkoutUrl: openPayment.invoiceUrl,
      expiresAt: null,
      type: 'INVOICE',
    };
  }

  private assertCanBuyWithoutGatewaySubscription(
    subscription: Subscription,
    planId: Subscription.PlanIdType,
    now: Date,
  ): void {
    const { paidUntil } = subscription;

    if (!paidUntil || paidUntil <= now) {
      return;
    }

    const msLeft = paidUntil.getTime() - now.getTime();
    const isYearlyRenewal = subscription.planId === Subscription.PlanId.PRO_YEARLY
      && planId === Subscription.PlanId.PRO_YEARLY
      && msLeft <= CreateCheckoutUseCase.YEARLY_RENEWAL_WINDOW_DAYS * 86_400_000;

    if (isYearlyRenewal) {
      return;
    }

    throw new SubscriptionAlreadyActive();
  }

  private canReusePendingCheckout(
    pendingCheckout: SubscriptionRepository.PendingCheckout,
    planId: Subscription.PlanIdType,
    returnUrl: string,
    now: Date,
  ): boolean {
    const msLeft = pendingCheckout.checkoutExpiresAt.getTime() - now.getTime();

    return pendingCheckout.planId === planId
      && pendingCheckout.returnUrl === returnUrl
      && msLeft > CreateCheckoutUseCase.PENDING_CHECKOUT_MIN_REMAINING_MS;
  }

  private normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }
}

export namespace CreateCheckoutUseCase {
  export type Input = {
    accountId: string;
    planId: Subscription.PlanIdType;
    returnUrl: string;
  };

  export type Output = {
    checkoutUrl: string;
    expiresAt: string | null;
    type: 'CHECKOUT' | 'INVOICE';
  };
}
