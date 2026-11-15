import { Controller } from '@application/contracts/Controller';
import { CheckoutBody, checkoutSchema } from '@application/controllers/billing/schemas/checkoutSchema';
import { CreateCheckoutUseCase } from '@application/useCases/billing/CreateCheckoutUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(checkoutSchema)
@RateLimit({ scope: 'account', limit: 10, windowSeconds: 3600 })
export class CreateCheckoutController extends Controller<'private'> {

  constructor(private readonly createCheckoutUseCase: CreateCheckoutUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate<CheckoutBody>): Promise<Controller.Response<CreateCheckoutController.Response>> {
    const { checkoutUrl, expiresAt, type } = await this.createCheckoutUseCase.execute({
      accountId: request.accountId,
      planId: request.body.planId,
      returnUrl: request.body.returnUrl,
    });

    return {
      statusCode: 200,
      body: { checkoutUrl, expiresAt, type },
    };
  }
}

namespace CreateCheckoutController {
  export type Response = CreateCheckoutUseCase.Output;
}
