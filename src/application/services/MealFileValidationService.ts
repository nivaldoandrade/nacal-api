import { Meal } from '@application/entities/Meal';
import { MealRejectedError } from '@application/errors/MealRejectedError';
import { Injectable } from '@kernel/decorators/Injectable';
import { imageSize } from 'image-size';
import { parseBuffer } from 'music-metadata';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MIN_AUDIO_DURATION_SECONDS = 1;
const MAX_AUDIO_DURATION_SECONDS = 32;

const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2']);

@Injectable()
export class MealFileValidationService {
  async validate({ meal, file }: MealFileValidationService.Input): Promise<MealFileValidationService.Result> {
    const { mimeType } = Meal.getInputFileByKey(meal.requireInputFileKey());

    if (meal.inputType === Meal.InputType.PICTURE) {
      return this.validateImage({ mimeType, file });
    }

    return this.validateAudio({ mimeType, file });
  }

  private validateImage({
    mimeType,
    file,
  }: MealFileValidationService.ValidateInput): MealFileValidationService.ImageResult {
    if (file.length > MAX_IMAGE_BYTES) {
      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }

    if (mimeType !== 'image/jpeg' || !this.isJpeg(file)) {
      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }

    try {
      const dimensions = imageSize(file);

      if (!dimensions.width || !dimensions.height) {
        throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
      }

      return {
        width: dimensions.width,
        height: dimensions.height,
      };
    } catch (error) {
      if (error instanceof MealRejectedError) {
        throw error;
      }

      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }
  }

  private async validateAudio({
    mimeType,
    file,
  }: MealFileValidationService.ValidateInput): Promise<MealFileValidationService.AudioResult> {
    if (file.length > MAX_AUDIO_BYTES) {
      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }

    if (mimeType === 'audio/m4a' && !this.isM4a(file)) {
      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }

    if (mimeType === 'audio/webm' && !this.isWebm(file)) {
      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }

    try {
      const metadata = await parseBuffer(file, {
        mimeType,
        size: file.length,
      });
      const durationSeconds = metadata.format.duration;

      if (
        !durationSeconds
        || durationSeconds < MIN_AUDIO_DURATION_SECONDS
        || durationSeconds > MAX_AUDIO_DURATION_SECONDS
      ) {
        throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
      }

      return { durationSeconds };
    } catch (error) {
      if (error instanceof MealRejectedError) {
        throw error;
      }

      throw new MealRejectedError(Meal.RejectionReason.INVALID_FILE);
    }
  }

  private isJpeg(file: Buffer): boolean {
    return file.length >= 3
      && file[0] === 0xff
      && file[1] === 0xd8
      && file[2] === 0xff;
  }

  private isM4a(file: Buffer): boolean {
    if (file.length < 12 || file.toString('ascii', 4, 8) !== 'ftyp') {
      return false;
    }

    const brand = file.toString('ascii', 8, 12);
    return M4A_BRANDS.has(brand);
  }

  private isWebm(file: Buffer): boolean {
    return file.length >= 4
      && file[0] === 0x1a
      && file[1] === 0x45
      && file[2] === 0xdf
      && file[3] === 0xa3;
  }
}

export namespace MealFileValidationService {
  export type Input = {
    meal: Meal;
    file: Buffer;
  }

  export type ValidateInput = {
    mimeType: Meal.MimeType;
    file: Buffer;
  }

  export type ImageResult = {
    width: number;
    height: number;
  }

  export type AudioResult = {
    durationSeconds: number;
  }

  export type Result = ImageResult | AudioResult;
}
