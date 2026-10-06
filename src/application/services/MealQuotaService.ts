import { Subscription } from '@application/entities/Subscription';
import { FreeQuotaExceeded } from '@application/errors/application/FreeQuotaExceeded';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealQuotaService {
  static readonly FREE_LIMIT = 20;

  constructor(private readonly rateLimitRepository: RateLimitRepository) { }

  async consume({ accountId, plan }: MealQuotaService.Input): Promise<MealQuotaService.Result> {
    const limit = plan === 'FREE' ? MealQuotaService.FREE_LIMIT : undefined;

    const used = await this.rateLimitRepository.incrementCalendarMonth({
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
    };
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
}
