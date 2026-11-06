import * as z from 'zod/mini';

const MAX_TEXT_LENGTH = 300;

export const addMealItemsSchema = z.object({
  text: z.string().check(
    z.trim(),
    z.minLength(1, 'text is required.'),
    z.maxLength(MAX_TEXT_LENGTH, `text must not exceed ${MAX_TEXT_LENGTH} characters.`),
  ),
});

export type AddMealItemsBody = z.infer<typeof addMealItemsSchema>;
