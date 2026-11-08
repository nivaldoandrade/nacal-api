import { Controller } from '@application/contracts/Controller';
import { GetMealByIdController } from '@application/controllers/meal/GetMealByIdController';
import { RemoveMealItemUseCase } from '@application/useCases/meal/RemoveMealItemUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';

@Injectable()
@RateLimit({ scope: 'account', limit: 60, windowSeconds: 3600 })
export class RemoveMealItemController extends Controller<'private'> {

  constructor(private readonly removeMealItemUseCase: RemoveMealItemUseCase) {
    super();
  }

  protected async handler(
    request: RemoveMealItemController.Request,
  ): Promise<Controller.Response<RemoveMealItemController.Response>> {
    const { meal } = await this.removeMealItemUseCase.execute({
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

export namespace RemoveMealItemController {
  export type Request = Controller.RequestPrivate<Record<string, unknown>, { id: string; itemId: string }>;

  export type Response = {
    meal: GetMealByIdController.Response;
  }
}
