/* eslint-disable no-console */
import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import { Meal } from '@application/entities/Meal';
import { MealRejectedError } from '@application/errors/MealRejectedError';
import { MealNamingService } from '@application/services/MealNamingService';
import { getImagePrompt } from '@infra/ai/prompts/getImagePrompt';
import { getTextPrompt } from '@infra/ai/prompts/getTextPrompt';
import { MealFileStorageGateway } from '@infra/gateways/MealFileStorageGateway';
import { downloadByURL } from '@infra/utils/downloadByURL';
import { Injectable } from '@kernel/decorators/Injectable';

const schema = z.object({
  mealType: z.enum(MealNamingService.MEAL_TYPES).nullable(),
  foods: z.array(
    z.object({
      name: z.string(),
      quantity: z.string(),
      carbohydrates: z.number(),
      fats: z.number(),
      proteins: z.number(),
    }),
  ),
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
    const input: OpenAI.Responses.ResponseInput = [
      {
        role: 'system',
        content: getImagePrompt(),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: this.mealFileStorageGateway.getFileURL(meal.inputFileKey),
            detail: 'high',
          },
        ],
      },
    ];

    const processedMeal = await this.callOpenAI(meal, input);

    return processedMeal;
  }

  private async processMealByAudio(meal: Meal): Promise<MealAiGateway.ProcessMeal['result']> {
    const audioTranscript = await this.transcribe(meal);

    const input: OpenAI.Responses.ResponseInput = [
      {
        role: 'system',
        content: getTextPrompt(),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Meal: ${audioTranscript}`,
          },
        ],
      },
    ];

    const processedMeal = await this.callOpenAI(meal, input);

    return processedMeal;
  }

  private async transcribe(meal: Meal): Promise<string> {
    const audioUrl = this.mealFileStorageGateway.getFileURL(meal.inputFileKey);
    const audioBuffer = await downloadByURL(audioUrl);
    const inputFile = Meal.getInputFileByKey(meal.inputFileKey);

    const transcription = await this.client.audio.transcriptions.create({
      model: 'gpt-4o-mini-transcribe',
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

  private async callOpenAI(meal: Meal, input: OpenAI.Responses.ResponseInput) {
    const response = await this.client.responses.create({
      model: 'gpt-5.4-mini',
      input,
      text: {
        format: zodTextFormat(schema, 'meal'),
      },
    });

    const { output_text } = response;
    const openAiResponseStringify = JSON.stringify(response, null, 2);

    if (!output_text) {
      console.error(`OPEN AI response: ${openAiResponseStringify}`);
      throw new Error(`OPEN AI error in meal: ${meal.id}`);
    }

    let parsedOutput: unknown;

    try {
      parsedOutput = JSON.parse(output_text);
    } catch (error) {
      throw new Error(
        `OPEN AI invalid JSON response in meal: ${meal.id}`,
        { cause: error },
      );
    }

    const {
      success,
      data,
      error,
    } = schema.safeParse(parsedOutput);

    if (!success) {
      console.log(`Zod error: ${JSON.stringify(error.issues, null, 2)}`);
      console.error(`OPEN AI response: ${openAiResponseStringify}`);
      throw new Error(`OPEN AI error in meal: ${meal.id}`);
    }

    return data;
  }

}

export namespace MealAiGateway {
  export type ProcessMeal = {
    result: z.infer<typeof schema>;
  }
}
