import { ApplicationError } from '@application/errors/application/ApplicationError';
import { ErrorCode } from '@application/errors/ErrorCode';

export class EmailLinkedToGoogle extends ApplicationError {
  public statusCode = 409;
  public code: ErrorCode = 'EMAIL_LINKED_TO_GOOGLE';

  constructor(message?: string) {
    super();
    this.name = EmailLinkedToGoogle.name;
    this.message = message ?? 'This email is linked to a Google account.';
  }
}
