import * as z from 'zod/mini';

import { Meal } from '@application/entities/Meal';

const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024;
const MAX_AUDIO_FILE_SIZE = 2 * 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 300;

export const createMealSchema = z.object({
  contentType: z.enum(Meal.mimeTypes),
  fileSize: z.number().check(
    z.positive('fileSize must be greater than 0MB.'),
    z.lte(MAX_IMAGE_FILE_SIZE, 'fileSize must not exceed 10MB.'),
  ),
  timeZone: z.optional(
    z.string().check(z.maxLength(64, 'timeZone is too long.')),
  ),
  description: z.optional(
    z.pipe(
      z.string().check(
        z.trim(),
        z.maxLength(MAX_DESCRIPTION_LENGTH, `description must not exceed ${MAX_DESCRIPTION_LENGTH} characters.`),
      ),
      z.transform((value) => value || undefined),
    ),
  ),
}).check(
  z.refine(
    ({ contentType, fileSize }) => (
      contentType.startsWith('audio/')
        ? fileSize <= MAX_AUDIO_FILE_SIZE
        : fileSize <= MAX_IMAGE_FILE_SIZE
    ),
    'fileSize exceeds the limit for this content type.',
  ),
  z.refine(
    ({ contentType, description }) => !description || contentType.startsWith('image/'),
    'description is only allowed for image meals.',
  ),
);

export type CreateMealBody = z.infer<typeof createMealSchema>;
