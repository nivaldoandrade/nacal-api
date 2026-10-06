import { Controller } from '@application/contracts/Controller';
import { Subscription } from '@application/entities/Subscription';
import { GetPlansUseCase } from '@application/useCases/billing/GetPlansUseCase';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetPlansController extends Controller<'private'> {

  constructor(private readonly getPlansUseCase: GetPlansUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate): Promise<Controller.Response<GetPlansController.Response>> {
    const { plans } = await this.getPlansUseCase.execute();

    return {
      statusCode: 200,
      body: { plans },
    };
  }
}

namespace GetPlansController {
  export type Response = {
    plans: Array<{
      id: Subscription.PlanIdType;
      name: string;
      price: number;
      cycle: string;
      trialDays: number;
      features: string[];
    }>;
  }
}
