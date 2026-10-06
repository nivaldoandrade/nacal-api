import { Controller } from '@application/contracts/Controller';
import { StartTrialUseCase } from '@application/useCases/billing/StartTrialUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';

@Injectable()
@RateLimit({ scope: 'account', limit: 5, windowSeconds: 3600 })
export class StartTrialController extends Controller<'private'> {

  constructor(private readonly startTrialUseCase: StartTrialUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate): Promise<Controller.Response<StartTrialController.Response>> {
    const { trialEndsAt } = await this.startTrialUseCase.execute({
      accountId: request.accountId,
    });

    return {
      statusCode: 200,
      body: { trialEndsAt },
    };
  }
}

namespace StartTrialController {
  export type Response = {
    trialEndsAt: Date;
  }
}
