import { Subscription } from '@application/entities/Subscription';
import { FreeQuotaExceeded } from '@application/errors/application/FreeQuotaExceeded';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealQuotaService {
  static readonly FREE_LIMIT = 20;

  constructor(private readonly rateLimitRepository: RateLimitRepository) { }

  async consume({ accountId, plan }: MealQuotaService.Input): Promise<MealQuotaService.ConsumeResult> {
    const limit = plan === 'FREE' ? MealQuotaService.FREE_LIMIT : undefined;

    const { used, bucket } = await this.rateLimitRepository.incrementCalendarMonth({
      scope: 'account-monthly',
      key: accountId,
      limit,
    });

    if (used === null) {
      throw new FreeQuotaExceeded();
    }

    return {
      used,
      limit: limit ?? null,
      remaining: limit === undefined ? null : Math.max(limit - used, 0),
      quotaMonth: bucket,
    };
  }

  async refund({ accountId, quotaMonth }: MealQuotaService.RefundInput): Promise<boolean> {
    return this.rateLimitRepository.decrementCalendarMonth({
      scope: 'account-monthly',
      key: accountId,
      bucket: quotaMonth,
    });
  }

  async ensureAvailable({ accountId, plan }: MealQuotaService.Input): Promise<void> {
    const { remaining } = await this.getUsage({ accountId, plan });

    if (remaining === 0) {
      throw new FreeQuotaExceeded();
    }
  }

  async getUsage({ accountId, plan }: MealQuotaService.Input): Promise<MealQuotaService.Result> {
    const used = await this.rateLimitRepository.getCountCalendarMonth({
      scope: 'account-monthly',
      key: accountId,
    });

    const limit = plan === 'FREE' ? MealQuotaService.FREE_LIMIT : undefined;

    return {
      used,
      limit: limit ?? null,
      remaining: limit === undefined ? null : Math.max(limit - used, 0),
    };
  }
}

export namespace MealQuotaService {
  export type Input = {
    accountId: string;
    plan: Subscription.EffectivePlan;
  }

  export type Result = {
    used: number;
    limit: number | null;
    remaining: number | null;
  }

  export type ConsumeResult = Result & {
    quotaMonth: string;
  }

  export type RefundInput = {
    accountId: string;
    quotaMonth: string;
  }
}
