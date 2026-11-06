import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class MealItemLimitReached extends ApplicationError {
  public statusCode = 409;
  public code: ErrorCode = 'MEAL_ITEM_LIMIT_REACHED';

  constructor(message?: string) {
    super();
    this.name = MealItemLimitReached.name;
    this.message = message ?? 'Meal item limit reached.';
  }

}
