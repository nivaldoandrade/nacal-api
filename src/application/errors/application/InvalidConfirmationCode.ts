import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class InvalidConfirmationCode extends ApplicationError {
  public statusCode = 400;
  public code: ErrorCode = 'INVALID_CONFIRMATION_CODE';

  constructor(message?: string) {
    super();
    this.name = InvalidConfirmationCode.name;
    this.message = message ?? 'Invalid or expired confirmation code.';
  }
}
