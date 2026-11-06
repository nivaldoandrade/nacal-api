import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class MealNotEditable extends ApplicationError {
  public statusCode = 409;
  public code: ErrorCode = 'MEAL_NOT_EDITABLE';

  constructor(message?: string) {
    super();
    this.name = MealNotEditable.name;
    this.message = message ?? 'Meal can no longer be edited.';
  }

}
