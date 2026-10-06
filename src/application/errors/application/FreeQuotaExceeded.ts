import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class FreeQuotaExceeded extends ApplicationError {
  public statusCode = 403;
  public code: ErrorCode = 'FREE_QUOTA_EXCEEDED';

  constructor(message?: string) {
    super();
    this.name = FreeQuotaExceeded.name;
    this.message = message ?? 'Free quota exceeded.';
  }

}
