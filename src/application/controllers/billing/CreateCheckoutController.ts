import { Controller } from '@application/contracts/Controller';
import { CheckoutBody, checkoutSchema } from '@application/controllers/billing/schemas/checkoutSchema';
import { CreateCheckoutUseCase } from '@application/useCases/billing/CreateCheckoutUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(checkoutSchema)
export class CreateCheckoutController extends Controller<'private'> {

  constructor(private readonly createCheckoutUseCase: CreateCheckoutUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate<CheckoutBody>): Promise<Controller.Response<CreateCheckoutController.Response>> {
    const { checkoutUrl, expiresAt } = await this.createCheckoutUseCase.execute({
      accountId: request.accountId,
      planId: request.body.planId,
      returnUrl: request.body.returnUrl,
    });

    return {
      statusCode: 200,
      body: { checkoutUrl, expiresAt },
    };
  }
}

namespace CreateCheckoutController {
  export type Response = {
    checkoutUrl: string;
    expiresAt: string;
  }
}
