import { Controller } from '@application/contracts/Controller';
import { DeleteMealUseCase } from '@application/useCases/meal/DeleteMealUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';

@Injectable()
@RateLimit({ scope: 'account', limit: 30, windowSeconds: 3600 })
export class DeleteMealController extends Controller<'private'> {

  constructor(private readonly deleteMealUseCase: DeleteMealUseCase) {
    super();
  }

  protected async handler(
    request: DeleteMealController.Request,
  ): Promise<Controller.Response> {
    await this.deleteMealUseCase.execute({
      accountId: request.accountId,
      mealId: request.params.id,
    });

    return {
      statusCode: 204,
    };
  }
}

export namespace DeleteMealController {
  export type Request = Controller.RequestPrivate<Record<string, unknown>, { id: string }>;
}
