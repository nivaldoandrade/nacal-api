/* eslint-disable no-console */
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

const GATE_MODEL = '@cf/cloudflare/clef-flash';
const GATE_MODEL_NAME = 'clef-flash';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const GATE_TIMEOUT_MS = 8_000;

@Injectable()
export class MealGateGateway {
  constructor(private readonly config: AppConfig) { }

  async evaluateImage({
    mealId,
    image,
    width,
    height,
  }: MealGateGateway.EvaluateImageParams): Promise<MealGateGateway.Result> {
    const startedAt = Date.now();
    const gateConfig = this.config.aiGate;

    if (!gateConfig.enabled) {
      return { decision: 'SKIP', reason: 'disabled' };
    }

    if (!gateConfig.accountId || !gateConfig.apiToken) {
      return { decision: 'SKIP', reason: 'missing_credentials' };
    }

    if (image.length > MAX_IMAGE_BYTES || width * height > MAX_IMAGE_PIXELS) {
      return { decision: 'SKIP', reason: 'image_too_large' };
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${gateConfig.accountId}/ai/run/${GATE_MODEL}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gateConfig.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GATE_MODEL_NAME,
          state: 'The image is a user-submitted photo for a food diary. Decide only whether it contains food or drink.',
          questions: {
            is_food_or_drink: {
              type: 'noul',
              instructions: 'Does this image show food or drink?',
              criteria: {
                true: 'At least one edible or drinkable item is visible, including packaged, raw, or partially eaten food or drink.',
                false: 'No edible or drinkable item is visible.',
              },
            },
          },
          images: [
            {
              content_type: 'image/jpeg',
              base64: image.toString('base64'),
            },
          ],
        }),
        signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
      });

      if (!response.ok) {
        return {
          decision: 'SKIP',
          reason: `http_${response.status}`,
        };
      }

      const body = await response.json() as MealGateGateway.ResponseBody;
      const score = body.result?.answers?.is_food_or_drink?.noul;

      if (!body.success || typeof score !== 'number') {
        return {
          decision: 'SKIP',
          reason: 'invalid_response',
        };
      }

      const decision = score < gateConfig.rejectThreshold ? 'REJECT' : 'ACCEPT';

      console.info(JSON.stringify({
        event: 'meal_gate',
        mealId,
        decision,
        score,
        threshold: gateConfig.rejectThreshold,
        latencyMs: Date.now() - startedAt,
        inputTokens: body.result?.usage?.input_tokens ?? null,
      }));

      return {
        decision,
        score,
      };
    } catch (error) {
      console.error(JSON.stringify({
        event: 'meal_gate_error',
        mealId,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.name : 'unknown',
      }));

      return {
        decision: 'SKIP',
        reason: 'request_failed',
      };
    }
  }
}

export namespace MealGateGateway {
  export type EvaluateImageParams = {
    mealId: string;
    image: Buffer;
    width: number;
    height: number;
  }

  export type Decision = 'ACCEPT' | 'REJECT' | 'SKIP';

  export type Result = {
    decision: Decision;
    score?: number;
    reason?: string;
  }

  export type ResponseBody = {
    success?: boolean;
    result?: {
      answers?: {
        is_food_or_drink?: {
          noul?: number;
        };
      };
      usage?: {
        input_tokens?: number;
      };
    };
  }
}
