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
import { logger } from '@shared/logger/logger';

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

const MODEL = 'gpt-5.4-mini';

const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

const MAX_OUTPUT_TOKENS = 4096;

const SYNC_TIMEOUT_MS = 12_000;

const SYNC_DEADLINE_MS = 25_000;

const ASYNC_DEADLINE_MS = 90_000;

const ASYNC_ANALYSIS_TIMEOUT_MS = 45_000;

const ASYNC_TRANSCRIPTION_TIMEOUT_MS = 30_000;

const ASYNC_DOWNLOAD_TIMEOUT_MS = 15_000;

const NOTE_STOP_WORDS = new Set([
  'com', 'sem', 'que', 'uma', 'uns', 'umas', 'para', 'pra', 'por', 'meu', 'minha', 'mais', 'tipo', 'sabor', 'marca',
  'copo', 'xicara', 'caneca', 'lata', 'garrafa', 'zero', 'acucar', 'natural', 'gelado', 'quente',
]);

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
    const signal = AbortSignal.timeout(ASYNC_DEADLINE_MS);

    try {
      const processedMeal = meal.inputType === Meal.InputType.PICTURE
        ? await this.processMealByImage(meal, signal)
        : await this.processMealByAudio(meal, signal);

      return processedMeal;
    } catch (error) {
      if (error instanceof MealRejectedError) {
        throw error;
      }

      throw new Error(`[OPEN AI] ${error}`, { cause: error });
    }

  }

  private async processMealByImage(meal: Meal, signal: AbortSignal): Promise<MealAiGateway.ProcessMeal['result']> {
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

    const { unidentified, mealType, foods: taggedFoods } = await this.callOpenAI({
      mealId: meal.id,
      operation: 'PICTURE',
      input,
      outputSchema: imageSchema,
      requestOptions: {
        timeout: ASYNC_ANALYSIS_TIMEOUT_MS,
        maxRetries: 1,
        signal,
      },
    });
    const { foods, unidentifiedFoods } = MealAiGateway.splitUnidentifiedFoods({
      mealId: meal.id,
      label: 'foods',
      taggedFoods,
    });

    return {
      mealType,
      foods,
      unidentified: MealAiGateway.resolveUnidentified({
        mealId: meal.id,
        unidentified: unidentified ?? unidentifiedFoods[0]?.kind ?? null,
        foods,
        note: meal.description,
      }),
    };
  }

  static resolveUnidentified({
    mealId,
    unidentified,
    foods,
    note,
  }: MealAiGateway.ResolveUnidentifiedParams): Meal.UnidentifiedKind | null {
    if (unidentified !== Meal.UnidentifiedKind.DRINK || !note) {
      return unidentified;
    }

    const noteWords = new Set(MealAiGateway.words(note));
    const noteDrink = foods.find((food) => (
      /\d\s*ml\b/i.test(food.quantity)
      && MealAiGateway.words(food.name).some((word) => noteWords.has(word))
    ));

    if (!noteDrink) {
      return unidentified;
    }

    logger.info('unidentified drink explained by note', { mealId, drink: noteDrink.name });

    return null;
  }

  private static words(value: string): string[] {
    return value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 3 && !NOTE_STOP_WORDS.has(word));
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
      const result = await this.callOpenAI({
        mealId,
        operation: 'ADD_ITEMS',
        input,
        outputSchema: addItemsSchema,
        requestOptions: MealAiGateway.syncRequestOptions(),
      });
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
        requestOptions: MealAiGateway.syncRequestOptions(),
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

  private async processMealByAudio(meal: Meal, signal: AbortSignal): Promise<MealAiGateway.ProcessMeal['result']> {
    const audioTranscript = await this.transcribe(meal, signal);

    const { mealType, foods } = await this.extractMealFromNote({
      mealId: meal.id,
      note: audioTranscript,
      source: 'AUDIO',
      requestOptions: {
        timeout: ASYNC_ANALYSIS_TIMEOUT_MS,
        maxRetries: 1,
        signal,
      },
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

    const { mealType, foods: taggedFoods } = await this.callOpenAI({
      mealId,
      operation: source,
      input,
      outputSchema: textMealSchema,
      requestOptions,
    });
    const { foods, unidentifiedFoods } = MealAiGateway.splitUnidentifiedFoods({
      mealId,
      label: `${source.toLowerCase()} foods`,
      taggedFoods,
    });

    return { mealType, foods, unidentifiedFoods };
  }

  private async transcribe(meal: Meal, signal: AbortSignal): Promise<string> {
    const inputFileKey = meal.requireInputFileKey();
    const audioUrl = this.mealFileStorageGateway.getFileURL(inputFileKey);
    const audioBuffer = await downloadByURL(audioUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(ASYNC_DOWNLOAD_TIMEOUT_MS)]),
    });
    const inputFile = Meal.getInputFileByKey(inputFileKey);
    const startedAt = Date.now();

    const transcription = await MealAiGateway.withDeadline(
      this.client.audio.transcriptions.create({
        model: TRANSCRIPTION_MODEL,
        file: await toFile(
          audioBuffer,
          `audio.${inputFile.extension}`,
          { type: inputFile.mimeType },
        ),
      }, {
        timeout: ASYNC_TRANSCRIPTION_TIMEOUT_MS,
        maxRetries: 1,
        signal,
      }),
      signal,
    );

    const { text, usage } = transcription;

    logger.info('openai transcription', {
      mealId: meal.id,
      model: TRANSCRIPTION_MODEL,
      durationMs: Date.now() - startedAt,
      audioBytes: audioBuffer.byteLength,
      transcriptChars: text.length,
      usage,
    });

    if (!text.trim()) {
      logger.warn('openai empty transcription', { mealId: meal.id });
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
      logger.info('unidentified foods removed', { mealId, label, unidentifiedFoods });
    }

    return { foods, unidentifiedFoods };
  }

  private static syncRequestOptions(): OpenAI.RequestOptions {
    return {
      timeout: SYNC_TIMEOUT_MS,
      maxRetries: 1,
      signal: AbortSignal.timeout(SYNC_DEADLINE_MS),
    };
  }

  private static withDeadline<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) {
      return promise;
    }

    promise.catch(() => undefined);

    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }

        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  }

  private static sanitize(value: string): string {
    return value
      .replace(/</g, '‹')
      .replace(/>/g, '›');
  }

  private async callOpenAI<TSchema extends z.ZodType>({
    mealId,
    operation,
    input,
    outputSchema,
    requestOptions,
  }: MealAiGateway.CallOpenAIParams<TSchema>): Promise<z.infer<TSchema>> {
    const startedAt = Date.now();

    const response = await MealAiGateway.withDeadline(
      this.client.responses.create({
        model: MODEL,
        input,
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: {
          format: zodTextFormat(outputSchema, 'meal'),
        },
      }, requestOptions),
      requestOptions.signal,
    );

    const { output_text, status, incomplete_details, usage } = response;

    logger.info('openai response', {
      mealId,
      operation,
      model: MODEL,
      responseStatus: status,
      incompleteReason: incomplete_details?.reason,
      durationMs: Date.now() - startedAt,
      usage: usage && {
        inputTokens: usage.input_tokens,
        cachedTokens: usage.input_tokens_details?.cached_tokens,
        outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens,
      },
    });

    if (status === 'incomplete') {
      throw new Error(
        `OPEN AI incomplete response (${incomplete_details?.reason ?? 'unknown'}) in meal: ${mealId}`,
      );
    }

    if (!output_text) {
      logger.error('openai empty output', { mealId, operation, response });
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
      logger.error('openai output does not match schema', {
        mealId,
        operation,
        issues: error.issues,
        outputText: output_text,
      });
      throw new Error(`OPEN AI error in meal: ${mealId}`);
    }

    return data;
  }

}

export namespace MealAiGateway {
  export type Operation = 'PICTURE' | 'AUDIO' | 'TEXT' | 'ADD_ITEMS';

  export type CallOpenAIParams<TSchema extends z.ZodType> = {
    mealId: string;
    operation: Operation;
    input: OpenAI.Responses.ResponseInput;
    outputSchema: TSchema;
    requestOptions: OpenAI.RequestOptions;
  }

  export type Food = z.infer<typeof foodSchema>;

  export type MealType = z.infer<typeof mealTypeSchema>;

  export type TaggedFood = z.infer<typeof taggedFoodSchema>;

  export type SplitFoods = {
    foods: Food[];
    unidentifiedFoods: { name: string; kind: Meal.UnidentifiedKind }[];
  }

  export type ResolveUnidentifiedParams = {
    mealId: string;
    unidentified: Meal.UnidentifiedKind | null;
    foods: Food[];
    note: string | null | undefined;
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
      requestOptions: OpenAI.RequestOptions;
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
