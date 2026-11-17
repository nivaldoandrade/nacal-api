import { Controller } from '@application/contracts/Controller';
import { GetMealByIdController } from '@application/controllers/meal/GetMealByIdController';
import { CreateTextMealBody, createTextMealSchema } from '@application/controllers/meal/schemas/createTextMealSchema';
import { MealQuotaService } from '@application/services/MealQuotaService';
import { CreateTextMealUseCase } from '@application/useCases/meal/CreateTextMealUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(createTextMealSchema)
@RateLimit({ scope: 'account', limit: 10, windowSeconds: 3600 })
export class CreateTextMealController extends Controller<'private'> {

  constructor(private readonly createTextMealUseCase: CreateTextMealUseCase) {
    super();
  }

  protected async handler(
    request: Controller.RequestPrivate<CreateTextMealBody>,
  ): Promise<Controller.Response<CreateTextMealController.Response>> {
    const { meal, unidentifiedFoodsCount, mealQuota, dailyMealQuota } = await this.createTextMealUseCase.execute({
      accountId: request.accountId,
      timeZone: request.body.timeZone,
      text: request.body.text,
    });

    return {
      statusCode: 201,
      body: {
        meal,
        unidentifiedFoodsCount,
        mealQuota,
        dailyMealQuota,
      },
    };
  }
}

export namespace CreateTextMealController {
  export type Response = MealQuotaService.Usage & {
    meal: GetMealByIdController.Response;
    unidentifiedFoodsCount: number;
  }
}
