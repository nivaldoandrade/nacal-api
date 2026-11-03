import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class EmailNotConfirmed extends ApplicationError {
  public statusCode = 403;
  public code: ErrorCode = 'EMAIL_NOT_CONFIRMED';

  constructor(message?: string) {
    super();
    this.name = EmailNotConfirmed.name;
    this.message = message ?? 'Email not confirmed.';
  }
}
