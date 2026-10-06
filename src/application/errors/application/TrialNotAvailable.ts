import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class TrialNotAvailable extends ApplicationError {
  public statusCode = 409;
  public code: ErrorCode = 'TRIAL_NOT_AVAILABLE';

  constructor(message?: string) {
    super();
    this.name = TrialNotAvailable.name;
    this.message = message ?? 'Trial not available.';
  }

}
