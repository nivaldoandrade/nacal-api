import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { BadRequest } from '@application/errors/http/BadRequest';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class CreateCheckoutUseCase {

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

    return { checkoutUrl, expiresAt };
  }

  private normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }
}

namespace CreateCheckoutUseCase {
  export type Input = {
    accountId: string;
    planId: Subscription.PlanIdType;
    returnUrl: string;
  };

  export type Output = {
    checkoutUrl: string;
    expiresAt: string;
  };
}
