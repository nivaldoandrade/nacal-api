/* eslint-disable no-console */
import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import { Meal } from '@application/entities/Meal';
import { MealRejectedError } from '@application/errors/MealRejectedError';
import { MealNamingService } from '@application/services/MealNamingService';
import { getAddItemsPrompt } from '@infra/ai/prompts/getAddItemsPrompt';
import { getImagePrompt } from '@infra/ai/prompts/getImagePrompt';
import { getTextMealPrompt } from '@infra/ai/prompts/getTextMealPrompt';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { downloadByURL } from '@infra/utils/downloadByURL';
import { Injectable } from '@kernel/decorators/Injectable';

const foodSchema = z.object({
  name: z.string(),
  quantity: z.string(),
  carbohydrates: z.number(),
  fats: z.number(),
  proteins: z.number(),
});

const unidentifiedKindSchema = z.enum(Meal.unidentifiedKinds).nullable();

const mealTypeSchema = z.enum(MealNamingService.MEAL_TYPES).nullable();

const taggedFoodSchema = foodSchema.extend({
  unidentifiedKind: unidentifiedKindSchema,
});

const imageSchema = z.object({
  unidentified: unidentifiedKindSchema,
  mealType: mealTypeSchema,
  foods: z.array(taggedFoodSchema),
});

const addItemsSchema = z.object({
  foods: z.array(taggedFoodSchema),
});

const SYNC_REQUEST_OPTIONS: OpenAI.RequestOptions = {
  timeout: 12_000,
  maxRetries: 1,
};

const textMealSchema = z.object({
  mealType: mealTypeSchema,
  foods: z.array(taggedFoodSchema),
});

@Injectable()
export class MealAiGateway {
  private readonly client = new OpenAI();

  constructor(
    private readonly mealFileStorageGateway: MealFileStorageGateway,
  ) { }

  async processMeal(meal: Meal): Promise<MealAiGateway.ProcessMeal['result']> {

    try {
      const processedMeal = meal.inputType === Meal.InputType.PICTURE
        ? await this.processMealByImage(meal)
        : await this.processMealByAudio(meal);

      return processedMeal;
    } catch (error) {
      if (error instanceof MealRejectedError) {
        throw error;
      }

      throw new Error(`[OPEN AI] ${error}`, { cause: error });
    }

  }

  private async processMealByImage(meal: Meal): Promise<MealAiGateway.ProcessMeal['result']> {
    const userContent: OpenAI.Responses.ResponseInputMessageContentList = [
      {
        type: 'input_image',
        image_url: this.mealFileStorageGateway.getFileURL(meal.requireInputFileKey()),
        detail: 'high',
      },
    ];

    if (meal.description) {
      userContent.push({
        type: 'input_text',
        text: `<user_note>\n${MealAiGateway.sanitize(meal.description)}\n</user_note>`,
      });
    }

    const input: OpenAI.Responses.ResponseInput = [
      {
        role: 'system',
        content: getImagePrompt(),
      },
      {
        role: 'user',
        content: userContent,
      },
    ];

    const { unidentified, mealType, foods: taggedFoods } = await this.callOpenAI(meal.id, input, imageSchema);
    const { foods, unidentifiedFoods } = MealAiGateway.splitUnidentifiedFoods({
      mealId: meal.id,
      label: 'foods',
      taggedFoods,
    });

    return {
      mealType,
      foods,
      unidentified: unidentified ?? unidentifiedFoods[0]?.kind ?? null,
    };
  }

  async extractFoodsFromText({
    mealId,
    text,
    existingFoods,
  }: MealAiGateway.ExtractFoodsFromText['params']): Promise<MealAiGateway.ExtractFoodsFromText['result']> {
    const registeredItems = existingFoods
      .map((food) => `${food.name} (${food.quantity})`)
      .join('; ');

    const input: OpenAI.Responses.ResponseInput = [
      {
        role: 'system',
        content: getAddItemsPrompt(),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `<registered_items>\n${MealAiGateway.sanitize(registeredItems)}\n</registered_items>`,
              `<user_note>\n${MealAiGateway.sanitize(text)}\n</user_note>`,
            ].join('\n'),
          },
        ],
      },
    ];

    try {
      const result = await this.callOpenAI(mealId, input, addItemsSchema, SYNC_REQUEST_OPTIONS);
      const { foods, unidentifiedFoods } = MealAiGateway.splitUnidentifiedFoods({
        mealId,
        label: 'added foods',
        taggedFoods: result.foods,
      });

      return {
        foods,
        unidentifiedCount: unidentifiedFoods.length,
      };
    } catch (error) {
      throw new Error(`[OPEN AI] ${error}`, { cause: error });
    }
  }

  async extractMealFromText({
    mealId,
    text,
  }: MealAiGateway.ExtractMealFromText['params']): Promise<MealAiGateway.ExtractMealFromText['result']> {
    try {
      const { mealType, foods, unidentifiedFoods } = await this.extractMealFromNote({
        mealId,
        note: text,
        source: 'TEXT',
        requestOptions: SYNC_REQUEST_OPTIONS,
      });

      return {
        mealType,
        foods,
        unidentifiedCount: unidentifiedFoods.length,
      };
    } catch (error) {
      throw new Error(`[OPEN AI] ${error}`, { cause: error });
    }
  }

  private async processMealByAudio(meal: Meal): Promise<MealAiGateway.ProcessMeal['result']> {
    const audioTranscript = await this.transcribe(meal);

    const { mealType, foods } = await this.extractMealFromNote({
      mealId: meal.id,
      note: audioTranscript,
      source: 'AUDIO',
    });

    return {
      mealType,
      foods,
      unidentified: null,
    };
  }

  private async extractMealFromNote({
    mealId,
    note,
    source,
    requestOptions,
  }: MealAiGateway.ExtractMealFromNote['params']): Promise<MealAiGateway.ExtractMealFromNote['result']> {
    const input: OpenAI.Responses.ResponseInput = [
      {
        role: 'system',
        content: getTextMealPrompt({ source }),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<user_note>\n${MealAiGateway.sanitize(note)}\n</user_note>`,
          },
        ],
      },
    ];

    const { mealType, foods: taggedFoods } = await this.callOpenAI(mealId, input, textMealSchema, requestOptions);
    const { foods, unidentifiedFoods } = MealAiGateway.splitUnidentifiedFoods({
      mealId,
      label: `${source.toLowerCase()} foods`,
      taggedFoods,
    });

    return { mealType, foods, unidentifiedFoods };
  }

  private async transcribe(meal: Meal): Promise<string> {
    const inputFileKey = meal.requireInputFileKey();
    const audioUrl = this.mealFileStorageGateway.getFileURL(inputFileKey);
    const audioBuffer = await downloadByURL(audioUrl);
    const inputFile = Meal.getInputFileByKey(inputFileKey);

    const transcription = await this.client.audio.transcriptions.create({
      model: 'gpt-4o-transcribe',
      file: await toFile(
        audioBuffer,
        `audio.${inputFile.extension}`,
        { type: inputFile.mimeType },
      ),
    });

    const { text } = transcription;

    if (!text.trim()) {
      console.error(`OPEN AI transcription response: ${JSON.stringify(transcription, null, 2)}`);
      throw new MealRejectedError(Meal.RejectionReason.NO_FOOD_DETECTED);
    }

    return text;

  }

  private static splitUnidentifiedFoods({
    mealId,
    label,
    taggedFoods,
  }: MealAiGateway.SplitUnidentifiedFoodsParams): MealAiGateway.SplitFoods {
    const foods: MealAiGateway.Food[] = [];
    const unidentifiedFoods: MealAiGateway.SplitFoods['unidentifiedFoods'] = [];

    for (const { unidentifiedKind, ...food } of taggedFoods) {
      if (unidentifiedKind) {
        unidentifiedFoods.push({ name: food.name, kind: unidentifiedKind });
      } else {
        foods.push(food);
      }
    }

    if (unidentifiedFoods.length > 0) {
      console.log(`[UNIDENTIFIED] meal ${mealId}: removed ${label} ${JSON.stringify(unidentifiedFoods)}`);
    }

    return { foods, unidentifiedFoods };
  }

  private static sanitize(value: string): string {
    return value
      .replace(/</g, '‹')
      .replace(/>/g, '›');
  }

  private async callOpenAI<TSchema extends z.ZodType>(
    mealId: string,
    input: OpenAI.Responses.ResponseInput,
    outputSchema: TSchema,
    requestOptions?: OpenAI.RequestOptions,
  ): Promise<z.infer<TSchema>> {
    const response = await this.client.responses.create({
      model: 'gpt-5.4-mini',
      input,
      text: {
        format: zodTextFormat(outputSchema, 'meal'),
      },
    }, requestOptions);

    const { output_text } = response;
    const openAiResponseStringify = JSON.stringify(response, null, 2);

    if (!output_text) {
      console.error(`OPEN AI response: ${openAiResponseStringify}`);
      throw new Error(`OPEN AI error in meal: ${mealId}`);
    }

    let parsedOutput: unknown;

    try {
      parsedOutput = JSON.parse(output_text);
    } catch (error) {
      throw new Error(
        `OPEN AI invalid JSON response in meal: ${mealId}`,
        { cause: error },
      );
    }

    const {
      success,
      data,
      error,
    } = outputSchema.safeParse(parsedOutput);

    if (!success) {
      console.log(`Zod error: ${JSON.stringify(error.issues, null, 2)}`);
      console.error(`OPEN AI response: ${openAiResponseStringify}`);
      throw new Error(`OPEN AI error in meal: ${mealId}`);
    }

    return data;
  }

}

export namespace MealAiGateway {
  export type Food = z.infer<typeof foodSchema>;

  export type MealType = z.infer<typeof mealTypeSchema>;

  export type TaggedFood = z.infer<typeof taggedFoodSchema>;

  export type SplitFoods = {
    foods: Food[];
    unidentifiedFoods: { name: string; kind: Meal.UnidentifiedKind }[];
  }

  export type SplitUnidentifiedFoodsParams = {
    mealId: string;
    label: string;
    taggedFoods: TaggedFood[];
  }

  export type ExtractMealFromNote = {
    params: {
      mealId: string;
      note: string;
      source: getTextMealPrompt.Params['source'];
      requestOptions?: OpenAI.RequestOptions;
    };
    result: {
      mealType: MealType;
      foods: Food[];
      unidentifiedFoods: SplitFoods['unidentifiedFoods'];
    };
  }

  export type ProcessMeal = {
    result: {
      mealType: MealType;
      foods: Food[];
      unidentified: Meal.UnidentifiedKind | null;
    };
  }

  export type ExtractFoodsFromText = {
    params: {
      mealId: string;
      text: string;
      existingFoods: Meal.FoodType[];
    };
    result: {
      foods: Food[];
      unidentifiedCount: number;
    };
  }

  export type ExtractMealFromText = {
    params: {
      mealId: string;
      text: string;
    };
    result: {
      mealType: MealType;
      foods: Food[];
      unidentifiedCount: number;
    };
  }
}
