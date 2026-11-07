import * as z from 'zod/mini';

const MAX_TEXT_LENGTH = 500;

export const createTextMealSchema = z.object({
  text: z.string().check(
    z.trim(),
    z.minLength(1, 'text is required.'),
    z.maxLength(MAX_TEXT_LENGTH, `text must not exceed ${MAX_TEXT_LENGTH} characters.`),
  ),
  timeZone: z.optional(
    z.string().check(z.maxLength(64, 'timeZone is too long.')),
  ),
});

export type CreateTextMealBody = z.infer<typeof createTextMealSchema>;
