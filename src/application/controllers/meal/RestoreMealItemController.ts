import { Controller } from '@application/contracts/Controller';
import { GetMealByIdController } from '@application/controllers/meal/GetMealByIdController';
import { RestoreMealItemUseCase } from '@application/useCases/meal/RestoreMealItemUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';

@Injectable()
@RateLimit({ scope: 'account', limit: 60, windowSeconds: 3600 })
export class RestoreMealItemController extends Controller<'private'> {

  constructor(private readonly restoreMealItemUseCase: RestoreMealItemUseCase) {
    super();
  }

  protected async handler(
    request: RestoreMealItemController.Request,
  ): Promise<Controller.Response<RestoreMealItemController.Response>> {
    const { meal } = await this.restoreMealItemUseCase.execute({
      accountId: request.accountId,
      mealId: request.params.id,
      itemId: request.params.itemId,
    });

    return {
      statusCode: 200,
      body: {
        meal,
      },
    };
  }
}

export namespace RestoreMealItemController {
  export type Request = Controller.RequestPrivate<Record<string, unknown>, { id: string; itemId: string }>;

  export type Response = {
    meal: GetMealByIdController.Response;
  }
}
