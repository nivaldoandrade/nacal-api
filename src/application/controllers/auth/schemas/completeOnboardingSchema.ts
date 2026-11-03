import { Profile } from '@application/entities/Profile';
import * as z from 'zod/mini';

export const completeOnboardingSchema = z.object({
  accessToken: z.string().check(z.trim(), z.minLength(1)),
  acceptedTerms: z.literal(true),
  gender: z.enum(Profile.Gender),
  height: z.number().check(z.positive()),
  weight: z.number().check(z.positive()),
  activityLevel: z.enum(Profile.ActivityLevel),
  goal: z.enum(Profile.Goal),
  birthDate: z.pipe(
    z.string().check(z.iso.date()),
    z.transform(date => new Date(date)),
  ),
});

export type CompleteOnboardingBody = z.infer<typeof completeOnboardingSchema>;
