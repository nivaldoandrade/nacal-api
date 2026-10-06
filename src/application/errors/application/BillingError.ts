import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class BillingError extends ApplicationError {
  public statusCode = 502;
  public code: ErrorCode = 'BILLING_ERROR';

  constructor(message?: string) {
    super();
    this.name = BillingError.name;
    this.message = message ?? 'Billing Error.';
  }

}
