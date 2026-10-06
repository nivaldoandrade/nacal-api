import { Controller } from '@application/contracts/Controller';
import { Subscription } from '@application/entities/Subscription';
import { CancelUseCase } from '@application/useCases/billing/CancelUseCase';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class CancelSubscriptionController extends Controller<'private'> {

  constructor(private readonly cancelUseCase: CancelUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate): Promise<Controller.Response<CancelSubscriptionController.Response>> {
    const { status } = await this.cancelUseCase.execute({
      accountId: request.accountId,
    });

    return {
      statusCode: 200,
      body: { status },
    };
  }
}

namespace CancelSubscriptionController {
  export type Response = {
    status: Subscription.StatusType;
  }
}
