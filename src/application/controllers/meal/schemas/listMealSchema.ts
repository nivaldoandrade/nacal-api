import * as z from 'zod/mini';

export const listMealQueryParamsSchema = z.object({
  date: z.string().check(z.iso.date()),
});

export type ListMealQueryParams = z.infer<
  typeof listMealQueryParamsSchema
>;
