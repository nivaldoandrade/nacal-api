import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class CodeDeliveryFailed extends ApplicationError {
  public statusCode = 502;
  public code: ErrorCode = 'CODE_DELIVERY_FAILED';

  constructor(message?: string) {
    super();
    this.name = CodeDeliveryFailed.name;
    this.message = message ?? 'Could not deliver the confirmation code.';
  }
}
