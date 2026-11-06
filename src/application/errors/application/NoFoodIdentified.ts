import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class NoFoodIdentified extends ApplicationError {
  public statusCode = 422;
  public code: ErrorCode = 'NO_FOOD_IDENTIFIED';

  constructor(message?: string) {
    super();
    this.name = NoFoodIdentified.name;
    this.message = message ?? 'No food identified in the text.';
  }

}
