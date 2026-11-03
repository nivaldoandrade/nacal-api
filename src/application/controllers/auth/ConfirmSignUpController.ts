import { Controller } from '@application/contracts/Controller';
import { ConfirmSignUpBody, confirmSignUpSchema } from '@application/controllers/auth/schemas/confirmSignUpSchema';
import { ConfirmSignUpUseCase } from '@application/useCases/auth/ConfirmSignUpUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(confirmSignUpSchema)
@RateLimit({ scope: 'ip', limit: 10, windowSeconds: 900 })
@RateLimit({ scope: 'email', field: 'email', limit: 10, windowSeconds: 900 })
export class ConfirmSignUpController extends Controller<'public'> {

  constructor(
    private readonly confirmSignUpUseCase: ConfirmSignUpUseCase,
  ) {
    super();
  }

  protected async handler(
    request: Controller.RequestPublic<ConfirmSignUpBody>,
  ): Promise<Controller.Response<ConfirmSignUpUseCase.Output>> {
    const { email, confirmationCode, password } = request.body;

    const result = await this.confirmSignUpUseCase.execute({ email, confirmationCode, password });

    return {
      statusCode: 200,
      body: result,
    };
  }
}
