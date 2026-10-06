import { Subscription } from '@application/entities/Subscription';
import * as z from 'zod/mini';

export const checkoutSchema = z.object({
  planId: z.enum(Subscription.PlanId),
  returnUrl: z.string().check(z.trim(), z.minLength(1)),
});

export type CheckoutBody = z.infer<typeof checkoutSchema>;
