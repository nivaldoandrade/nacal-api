import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class BetaAccessDenied extends ApplicationError {
  public statusCode = 403;
  public code: ErrorCode = 'BETA_ACCESS_DENIED';

  constructor(message?: string) {
    super();
    this.name = BetaAccessDenied.name;
    this.message = message ?? 'This email is not allowed in the beta.';
  }
}
