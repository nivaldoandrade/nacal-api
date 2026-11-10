import * as z from 'zod/mini';

export const envSchema = z.object({
  COGNITO_CLIENT_ID: z.string().check(z.trim(), z.minLength(1)),
  COGNITO_USER_POOL_ID: z.string().check(z.trim(), z.minLength(1)),
  COGNITO_CLIENT_SECRET: z.string().check(z.trim(), z.minLength(1)),
  MAIN_TABLE_NAME: z.string().check(z.trim(), z.minLength(1)),
  RATE_LIMIT_TABLE_NAME: z.string().check(z.trim(), z.minLength(1)),
  MEALS_BUCKET_NAME: z.string().check(z.trim(), z.minLength(1)),
  MEALS_CDN_DOMAIN_NAME: z.string().check(z.trim(), z.minLength(1)),
  MEALS_QUEUE_URL: z.string().check(z.trim(), z.minLength(1)),
  MEAL_UPLOAD_CHECK_QUEUE_URL: z.string().check(z.trim(), z.minLength(1)),
  COGNITO_POOL_DOMAIN: z.string().check(z.trim(), z.minLength(1)),
  ASAAS_BASE_URL: z.string().check(z.trim(), z.minLength(1)),
  ASAAS_API_KEY: z.string().check(z.trim(), z.minLength(1)),
  ASAAS_WEBHOOK_TOKEN: z.string().check(z.trim(), z.minLength(1)),
  ASAAS_WEBHOOK_ALLOWED_IPS: z.optional(z.string()),
  APP_WEB_URL: z.string().check(z.trim(), z.minLength(1)),
  CLOUDFLARE_ACCOUNT_ID: z.optional(z.string()),
  CLOUDFLARE_AI_API_TOKEN: z.optional(z.string()),
  MEAL_GATE_ENABLED: z.optional(z.string()),
  MEAL_GATE_REJECT_THRESHOLD: z.optional(z.string()),
  BETA_GATE_ENABLED: z.optional(z.string()),
  BETA_ALLOWED_EMAILS: z.optional(z.string()),
});

export const env = envSchema.parse(process.env);
