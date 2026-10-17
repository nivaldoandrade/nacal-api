import * as z from 'zod/mini';

import { Meal } from '@application/entities/Meal';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const createMealSchema = z.object({
  contentType: z.enum(Meal.mimeTypes),
  fileSize: z.number().check(
    z.positive('fileSize must be greater than 0MB.'),
    z.lte(MAX_FILE_SIZE, 'fileSize must not exceed 10MB.'),
  ),
  timeZone: z.optional(
    z.string().check(z.maxLength(64, 'timeZone is too long.')),
  ),
});

export type CreateMealBody = z.infer<typeof createMealSchema>;
