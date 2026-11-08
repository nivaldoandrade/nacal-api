import { Controller } from '@application/contracts/Controller';
import { Meal } from '@application/entities/Meal';
import { GetMealByIdUseCase } from '@application/useCases/meal/GetMealByIdUseCase';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetMealByIdController extends Controller<'private'> {

  constructor(
    private readonly getMealByIdUseCase: GetMealByIdUseCase,
  ) {
    super();
  }

  protected async handler(
    request: GetMealByIdController.Request,
  ): Promise<Controller.Response<GetMealByIdController.Response>> {
    const accountId = request.accountId;
    const mealId = request.params.id;

    const { meal } = await this.getMealByIdUseCase.execute({
      accountId,
      mealId,
    });

    return {
      statusCode: 200,
      body: {
        id: meal.id,
        name: meal.name,
        icon: meal.icon,
        status: meal.status,
        rejectionReason: meal.rejectionReason,
        foods: meal.foods,
        inputFileType: meal.inputFileType,
        inputFileUrl: meal.inputFileUrl,
        canAddItems: meal.canAddItems,
        canRemoveItems: meal.canRemoveItems,
        unidentified: meal.unidentified,
        createdAt: meal.createdAt,
      },
    };
  }
}

export namespace GetMealByIdController {

  export type Request = Controller.RequestPrivate<
    Record<string, unknown>,
    { id: string }
  >

  export type Response = {
    id: string;
    status: Meal.StatusType;
    rejectionReason: Meal.RejectionReason | null;
    inputFileType: Meal.InputType;
    inputFileUrl: string | null;
    name: string;
    icon: string;
    foods: Meal.FoodType[];
    canAddItems: boolean;
    canRemoveItems: boolean;
    unidentified: Meal.UnidentifiedKind | null;
    createdAt?: Date;
  }
}
