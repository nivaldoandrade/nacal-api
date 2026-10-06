import { Subscription } from '@application/entities/Subscription';
import { TrialNotAvailable } from '@application/errors/application/TrialNotAvailable';
import { SubscriptionRepository } from '@infra/databases/dynamodb/SubscriptionRepository';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class StartTrialUseCase {

  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
  ) { }

  async execute({ accountId }: StartTrialUseCase.Input): Promise<StartTrialUseCase.Output> {
    const existing = await this.subscriptionRepository.findByAccountId(accountId);

    if (existing) {
      throw new TrialNotAvailable();
    }

    const now = new Date();
    const trialDays = Subscription.Plan.PRO_MONTHLY.trialDays;
    const trialEndsAt = new Date(now.getTime() + trialDays * 86_400_000);

    const subscription = new Subscription({
      accountId,
      gateway: 'ASAAS',
      status: Subscription.Status.TRIALING,
      planId: Subscription.Plan.PRO_MONTHLY.id,
      trialStartedAt: now,
      trialEndsAt,
    });

    try {
      await this.subscriptionRepository.create(subscription);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new TrialNotAvailable();
      }

      throw error;
    }

    return { trialEndsAt };
  }
}

namespace StartTrialUseCase {
  export type Input = {
    accountId: string;
  };

  export type Output = {
    trialEndsAt: Date;
  };
}
