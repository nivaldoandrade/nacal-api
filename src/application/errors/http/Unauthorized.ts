import { ErrorCode } from '@application/errors/ErrorCode';
import { HttpError } from '@application/errors/http/HttpError';

export class Unauthorized extends HttpError {
  public readonly statusCode = 401;
  public readonly code: ErrorCode = 'UNAUTHORIZED';

  constructor(message?: string) {
    super();
    this.name = Unauthorized.name;
    this.message = message ?? 'Unauthorized';
  }
}
