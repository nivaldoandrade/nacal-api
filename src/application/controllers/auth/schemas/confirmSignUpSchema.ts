import * as z from 'zod/mini';

export const confirmSignUpSchema = z.object({
  email: z.email(),
  confirmationCode: z.string().check(z.trim(), z.minLength(1)),
  password: z.string().check(z.minLength(1)),
});

export type ConfirmSignUpBody = z.infer<typeof confirmSignUpSchema>;
