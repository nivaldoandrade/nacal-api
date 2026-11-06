import { Controller } from '@application/contracts/Controller';
import { AddMealItemsBody, addMealItemsSchema } from '@application/controllers/meal/schemas/addMealItemsSchema';
import { GetMealByIdController } from '@application/controllers/meal/GetMealByIdController';
import { Meal } from '@application/entities/Meal';
import { AddMealItemsUseCase } from '@application/useCases/meal/AddMealItemsUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(addMealItemsSchema)
@RateLimit({ scope: 'account', limit: 20, windowSeconds: 3600 })
export class AddMealItemsController extends Controller<'private'> {

  constructor(private readonly addMealItemsUseCase: AddMealItemsUseCase) {
    super();
  }

  protected async handler(
    request: AddMealItemsController.Request,
  ): Promise<Controller.Response<AddMealItemsController.Response>> {
    const { meal, addedFoods, skippedFoodsCount, unidentifiedFoodsCount } = await this.addMealItemsUseCase.execute({
      accountId: request.accountId,
      mealId: request.params.id,
      text: request.body.text,
    });

    return {
      statusCode: 200,
      body: {
        meal,
        addedFoods,
        skippedFoodsCount,
        unidentifiedFoodsCount,
      },
    };
  }
}

export namespace AddMealItemsController {
  export type Request = Controller.RequestPrivate<AddMealItemsBody, { id: string }>;

  export type Response = {
    meal: GetMealByIdController.Response;
    addedFoods: Meal.FoodType[];
    skippedFoodsCount: number;
    unidentifiedFoodsCount: number;
  }
}
