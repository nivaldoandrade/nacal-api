import { Controller } from '@application/contracts/Controller';
import { listMealQueryParamsSchema } from '@application/controllers/meal/schemas/listMealSchema';
import { Meal } from '@application/entities/Meal';
import { ListMealsByAccountIdAndDay } from '@application/query/ListMealsByAccountIdAndDay';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ListMealsController extends Controller<'private'> {

  constructor(
    private readonly listMealsByAccountIdAndDay: ListMealsByAccountIdAndDay,
  ) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate): Promise<Controller.Response<ListMealsController.Response>> {
    const { accountId, queryParams } = request;

    const { date } = listMealQueryParamsSchema.parse(queryParams);

    const { meals } = await this.listMealsByAccountIdAndDay.execute({
      accountId,
      date,
    });

    return {
      statusCode: 200,
      body: {
        meals,
      },
    };
  }

}

export namespace ListMealsController {
  export type Response = {
    meals: {
      id: string;
      name: string;
      icon: string;
      foods: Meal.FoodType[];
      createdAt: string;
      timeZone: string;
    }[]
  }
}
