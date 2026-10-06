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
    const subscription = await this.subscriptionRepository.findByAccountId(accountId);

    if (!subscription) {
      throw new BadRequest('Subscription not found.');
    }

    if (subscription.status === Subscription.Status.CANCELED) {
      return { status: subscription.status };
    }

    if (subscription.status === Subscription.Status.TRIALING) {
      subscription.status = Subscription.Status.CANCELED;
      subscription.canceledAt = new Date();
      subscription.paidUntil = undefined;
    } else {
      const subscriptionRef = subscription.gatewayRefs?.subscriptionId;

      if (!subscriptionRef) {
        throw new BillingError('Subscription reference not found.');
      }

      await this.paymentGateway.cancelSubscription({ subscriptionRef });

      subscription.status = Subscription.Status.CANCELED;
      subscription.canceledAt = new Date();
    }

    await this.subscriptionRepository.save(subscription);

    return { status: subscription.status };
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
