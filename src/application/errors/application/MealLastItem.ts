import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class MealLastItem extends ApplicationError {
  public statusCode = 409;
  public code: ErrorCode = 'MEAL_LAST_ITEM';

  constructor(message?: string) {
    super();
    this.name = MealLastItem.name;
    this.message = message ?? 'Meal must keep at least one item.';
  }

}
