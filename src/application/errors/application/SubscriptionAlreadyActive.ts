import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class SubscriptionAlreadyActive extends ApplicationError {
  public statusCode = 409;
  public code: ErrorCode = 'SUBSCRIPTION_ALREADY_ACTIVE';

  constructor(message?: string) {
    super();
    this.name = SubscriptionAlreadyActive.name;
    this.message = message ?? 'Subscription already active.';
  }

}
