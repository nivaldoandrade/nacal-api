import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { Subscription } from '@application/entities/Subscription';
import { BillingError } from '@application/errors/application/BillingError';
import { BadRequest } from '@application/errors/http/BadRequest';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class CancelUseCase {

  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly paymentGateway: IPaymentGateway,
  ) { }

  async execute({ accountId }: CancelUseCase.Input): Promise<CancelUseCase.Output> {
    let subscription = await this.subscriptionRepository.findByAccountId(accountId);

    if (!subscription) {
      throw new BadRequest('Subscription not found.');
    }

    if (subscription.status === Subscription.Status.CANCELED) {
      return { status: subscription.status };
    }

    const isTrial = subscription.status === Subscription.Status.TRIALING;
    const subscriptionRef = subscription.gatewayRefs?.subscriptionId;

    if (!isTrial) {
      if (!subscriptionRef) {
        throw new BillingError('Subscription reference not found.');
      }

      await this.paymentGateway.cancelSubscription({ subscriptionRef });
    }

    for (let attempt = 1; attempt <= SubscriptionRepository.MAX_WRITE_ATTEMPTS; attempt++) {
      if (!subscription) {
        throw new BadRequest('Subscription not found.');
      }

      const isSameSubscription = isTrial
        ? subscription.status === Subscription.Status.TRIALING
        : subscription.gatewayRefs?.subscriptionId === subscriptionRef;

      if (subscription.status === Subscription.Status.CANCELED || !isSameSubscription) {
        return { status: subscription.status };
      }

      subscription.status = Subscription.Status.CANCELED;
      subscription.canceledAt = new Date();

      if (isTrial) {
        subscription.paidUntil = undefined;
      }

      if (await this.subscriptionRepository.save(subscription)) {
        return { status: subscription.status };
      }

      subscription = await this.subscriptionRepository.findByAccountId(accountId);
    }

    throw new Error('Subscription write conflict.');
  }
}

namespace CancelUseCase {
  export type Input = {
    accountId: string;
  };

  export type Output = {
    status: Subscription.StatusType;
  };
}
