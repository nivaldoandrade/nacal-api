import * as z from 'zod/mini';

export const resendConfirmationCodeSchema = z.object({
  email: z.email(),
});

export type ResendConfirmationCodeBody = z.infer<typeof resendConfirmationCodeSchema>;
