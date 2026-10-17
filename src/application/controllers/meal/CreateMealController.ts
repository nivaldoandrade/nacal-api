import { Controller } from '@application/contracts/Controller';
import { CreateMealBody, createMealSchema } from '@application/controllers/meal/schemas/createMealSchema';
import { Meal } from '@application/entities/Meal';
import { CreateMealUseCase } from '@application/useCases/meal/CreateMealUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(createMealSchema)
@RateLimit({ scope: 'account', limit: 10, windowSeconds: 3600 })
export class CreateMealController extends Controller<'private'> {

  constructor(private readonly createMealUseCase: CreateMealUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate<CreateMealBody>): Promise<Controller.Response<CreateMealController.Response>> {
    const accountId = request.accountId;
    const { contentType, fileSize, timeZone } = request.body;

    const inputFile = Meal.getInputFile(contentType);

    const {
      mealId,
      uploadSignature,
    } = await this.createMealUseCase.execute({
      accountId,
      timeZone,
      file: {
        mimeType: contentType,
        inputType: inputFile.inputType,
        size: fileSize,
      },
    });

    return {
      statusCode: 201,
      body: {
        mealId,
        uploadSignature,
      },
    };
  }

}

namespace CreateMealController {
  export type Response = {
    mealId: string;
    uploadSignature: string;
  }
}
