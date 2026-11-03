import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class TooManyAttempts extends ApplicationError {
  public statusCode = 429;
  public code: ErrorCode = 'TOO_MANY_ATTEMPTS';

  constructor(message?: string) {
    super();
    this.name = TooManyAttempts.name;
    this.message = message ?? 'Too many attempts. Try again later.';
  }
}
