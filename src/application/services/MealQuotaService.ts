import { Subscription } from '@application/entities/Subscription';
import { DailyMealLimitReached } from '@application/errors/application/DailyMealLimitReached';
import { FreeQuotaExceeded } from '@application/errors/application/FreeQuotaExceeded';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class MealQuotaService {
  static readonly FREE_MONTHLY_LIMIT = 20;

  static readonly PRO_DAILY_LIMIT = Subscription.PRO_DAILY_MEAL_LIMIT;

  static readonly DAY_TIME_ZONE = 'America/Sao_Paulo';

  static readonly PRO_MONTH_SUFFIX = '#PRO';

  constructor(private readonly rateLimitRepository: RateLimitRepository) { }

  async consume({ accountId, plan }: MealQuotaService.Input): Promise<MealQuotaService.ConsumeResult> {
    const now = new Date();
    const month = RateLimitRepository.getCalendarMonthBucket(now);

    if (plan === 'FREE') {
      const used = await this.rateLimitRepository.incrementQuotaCounter({
        scope: 'account-monthly',
        key: accountId,
        bucket: month.bucket,
        expiresAt: month.expiresAt,
        limit: MealQuotaService.FREE_MONTHLY_LIMIT,
      });

      if (used === null) {
        throw new FreeQuotaExceeded();
      }

      return {
        quotaMonth: month.bucket,
        quotaDay: null,
      };
    }

    const day = RateLimitRepository.getCalendarDayBucket(now, MealQuotaService.DAY_TIME_ZONE);

    const usedToday = await this.rateLimitRepository.incrementQuotaCounter({
      scope: 'account-daily',
      key: accountId,
      bucket: day.bucket,
      expiresAt: day.expiresAt,
      limit: MealQuotaService.PRO_DAILY_LIMIT,
    });

    if (usedToday === null) {
      throw new DailyMealLimitReached();
    }

    const quotaMonth = MealQuotaService.getProMonthBucket(month.bucket);

    try {
      await this.rateLimitRepository.incrementQuotaCounter({
        scope: 'account-monthly',
        key: accountId,
        bucket: quotaMonth,
        expiresAt: month.expiresAt,
      });
    } catch (error) {
      try {
        await this.rateLimitRepository.decrementQuotaCounter({
          scope: 'account-daily',
          key: accountId,
          bucket: day.bucket,
        });
      } catch (refundError) {
        throw new AggregateError(
          [error, refundError],
          `Failed to count Pro meal and refund daily quota for account ${accountId}.`,
          { cause: refundError },
        );
      }

      throw error;
    }

    return {
      quotaMonth,
      quotaDay: day.bucket,
    };
  }

  async refund({ accountId, quotaMonth, quotaDay }: MealQuotaService.RefundInput): Promise<void> {
    await Promise.all([
      this.rateLimitRepository.decrementQuotaCounter({
        scope: 'account-monthly',
        key: accountId,
        bucket: quotaMonth,
      }),
      quotaDay
        ? this.rateLimitRepository.decrementQuotaCounter({
          scope: 'account-daily',
          key: accountId,
          bucket: quotaDay,
        })
        : Promise.resolve(false),
    ]);
  }

  async ensureCanCreateMeal({ accountId, plan }: MealQuotaService.Input): Promise<void> {
    if (plan === 'FREE') {
      await this.ensureFreeQuotaAvailable(accountId);
      return;
    }

    const dailyMealQuota = await this.getDailyUsage(accountId, new Date());

    if (dailyMealQuota.remaining === 0) {
      throw new DailyMealLimitReached();
    }
  }

  async ensureCanAddItems({ accountId, plan }: MealQuotaService.Input): Promise<void> {
    if (plan !== 'FREE') {
      return;
    }

    await this.ensureFreeQuotaAvailable(accountId);
  }

  private async ensureFreeQuotaAvailable(accountId: string): Promise<void> {
    const { mealQuota } = await this.getUsage({ accountId, plan: 'FREE' });

    if (mealQuota.remaining === 0) {
      throw new FreeQuotaExceeded();
    }
  }

  async getUsage({ accountId, plan }: MealQuotaService.Input): Promise<MealQuotaService.Usage> {
    const now = new Date();
    const { bucket: monthBucket } = RateLimitRepository.getCalendarMonthBucket(now);

    if (plan === 'FREE') {
      const used = await this.rateLimitRepository.getQuotaCount({
        scope: 'account-monthly',
        key: accountId,
        bucket: monthBucket,
      });

      return {
        mealQuota: MealQuotaService.toQuota(used, MealQuotaService.FREE_MONTHLY_LIMIT),
        dailyMealQuota: null,
      };
    }

    const [usedThisMonth, dailyMealQuota] = await Promise.all([
      this.rateLimitRepository.getQuotaCount({
        scope: 'account-monthly',
        key: accountId,
        bucket: MealQuotaService.getProMonthBucket(monthBucket),
      }),
      this.getDailyUsage(accountId, now),
    ]);

    return {
      mealQuota: MealQuotaService.toQuota(usedThisMonth, null),
      dailyMealQuota,
    };
  }

  private async getDailyUsage(accountId: string, now: Date): Promise<MealQuotaService.Quota> {
    const { bucket } = RateLimitRepository.getCalendarDayBucket(now, MealQuotaService.DAY_TIME_ZONE);

    const usedToday = await this.rateLimitRepository.getQuotaCount({
      scope: 'account-daily',
      key: accountId,
      bucket,
    });

    return MealQuotaService.toQuota(usedToday, MealQuotaService.PRO_DAILY_LIMIT);
  }

  private static getProMonthBucket(monthBucket: string): string {
    return `${monthBucket}${MealQuotaService.PRO_MONTH_SUFFIX}`;
  }

  private static toQuota(used: number, limit: number | null): MealQuotaService.Quota {
    return {
      used,
      limit,
      remaining: limit === null ? null : Math.max(limit - used, 0),
    };
  }
}

export namespace MealQuotaService {
  export type Input = {
    accountId: string;
    plan: Subscription.EffectivePlan;
  }

  export type Quota = {
    used: number;
    limit: number | null;
    remaining: number | null;
  }

  export type Usage = {
    mealQuota: Quota;
    dailyMealQuota: Quota | null;
  }

  export type ConsumeResult = {
    quotaMonth: string;
    quotaDay: string | null;
  }

  export type RefundInput = {
    accountId: string;
    quotaMonth: string;
    quotaDay: string | null;
  }
}
