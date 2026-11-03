import { Controller } from '@application/contracts/Controller';
import { ResendConfirmationCodeBody, resendConfirmationCodeSchema } from '@application/controllers/auth/schemas/resendConfirmationCodeSchema';
import { ResendConfirmationCodeUseCase } from '@application/useCases/auth/ResendConfirmationCodeUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(resendConfirmationCodeSchema)
@RateLimit({ scope: 'ip', limit: 3, windowSeconds: 900 })
@RateLimit({ scope: 'email', field: 'email', limit: 3, windowSeconds: 900 })
export class ResendConfirmationCodeController extends Controller<'public'> {

  constructor(
    private readonly resendConfirmationCodeUseCase: ResendConfirmationCodeUseCase,
  ) {
    super();
  }

  protected async handler(
    request: Controller.RequestPublic<ResendConfirmationCodeBody>,
  ): Promise<Controller.Response> {
    const { email } = request.body;

    await this.resendConfirmationCodeUseCase.execute({ email });

    return {
      statusCode: 204,
    };
  }
}
