import { Controller } from '@application/contracts/Controller';
import { SignUpBody, signUpSchema } from '@application/controllers/auth/schemas/signUpSchema';
import { SignUpUseCase } from '@application/useCases/auth/SignUpUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(signUpSchema)
@RateLimit({ scope: 'ip', limit: 5, windowSeconds: 900 })
export class SignUpController extends Controller<'public'> {

  constructor(
    private readonly signUpUseCase: SignUpUseCase,
  ) {
    super();
  }

  protected async handler(
    request: Controller.RequestPublic<SignUpBody>,
  ): Promise<Controller.Response<SignUpController.Response>> {

    const { account, profile } = request.body;

    const { requiresConfirmation, alreadyPending } = await this.signUpUseCase.execute({
      account,
      profile,
    });

    return {
      statusCode: 201,
      body: {
        requiresConfirmation,
        alreadyPending,
      },
    };
  }

}

namespace SignUpController {
  export type Response = {
    requiresConfirmation: boolean;
    alreadyPending: boolean;
  }
}
