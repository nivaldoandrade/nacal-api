import { Profile } from '@application/entities/Profile';
import * as z from 'zod/mini';

export const signUpSchema = z.object({
  acceptedTerms: z.literal(true),
  account: z.object({
    email: z.email(),
    password: z.string().check(z.trim(), z.minLength(8)),
  }),
  profile: z.object({
    name: z.string().check(z.trim(), z.minLength(1)),
    gender: z.enum(Profile.Gender),
    height: z.number().check(z.positive()),
    weight: z.number().check(z.positive()),
    activityLevel: z.enum(Profile.ActivityLevel),
    goal: z.enum(Profile.Goal),
    birthDate: z.pipe(
      z.string().check(z.iso.date()),
      z.transform(date => new Date(date)),
    ),
  }),
});

export type SignUpBody = z.infer<typeof signUpSchema>;
