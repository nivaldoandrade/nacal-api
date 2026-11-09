import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class DailyMealLimitReached extends ApplicationError {
  public statusCode = 429;
  public code: ErrorCode = 'DAILY_MEAL_LIMIT_REACHED';

  constructor(message?: string) {
    super();
    this.name = DailyMealLimitReached.name;
    this.message = message ?? 'Daily meal limit reached.';
  }

}
