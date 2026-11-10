import { Injectable } from '@kernel/decorators/Injectable';
import { env } from '@shared/config/env';

const ASAAS_WEBHOOK_PRODUCTION_IPS = [
  '52.67.12.206',
  '18.230.8.159',
  '54.94.136.112',
  '54.94.183.101',
];

@Injectable()
export class AppConfig {
  readonly envAuth: AppConfig.EnvAuth;

  readonly db: AppConfig.Db;

  readonly storage: AppConfig.Storage;

  readonly cdn: AppConfig.CDN;

  readonly queue: AppConfig.Queue;

  readonly billing: AppConfig.Billing;

  readonly aiGate: AppConfig.AiGate;

  constructor() {
    this.envAuth = {
      cognito: {
        clientId: env.COGNITO_CLIENT_ID,
        userPoolId: env.COGNITO_USER_POOL_ID,
        clientSecret: env.COGNITO_CLIENT_SECRET,
        userPooldomain: env.COGNITO_POOL_DOMAIN,
      },
    };

    this.db = {
      dynamodb: {
        mainTable: env.MAIN_TABLE_NAME,
        rateLimitTable: env.RATE_LIMIT_TABLE_NAME,
      },
    };

    this.storage = {
      mealsBucketName: env.MEALS_BUCKET_NAME,
    };

    this.cdn = {
      mealsCDN: env.MEALS_CDN_DOMAIN_NAME,
    };

    this.queue = {
      mealsQueueUrl: env.MEALS_QUEUE_URL,
      mealUploadCheckQueueUrl: env.MEAL_UPLOAD_CHECK_QUEUE_URL,
    };

    this.billing = {
      asaas: {
        apiKey: env.ASAAS_API_KEY,
        baseUrl: env.ASAAS_BASE_URL,
        webhookToken: env.ASAAS_WEBHOOK_TOKEN,
        webhookAllowedIps: parseAsaasWebhookAllowedIps(env.ASAAS_WEBHOOK_ALLOWED_IPS),
      },
      appWebUrl: env.APP_WEB_URL,
    };

    this.aiGate = {
      enabled: parseGateEnabled(env.MEAL_GATE_ENABLED),
      rejectThreshold: parseGateThreshold(env.MEAL_GATE_REJECT_THRESHOLD),
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_AI_API_TOKEN,
    };
  }

}

function parseGateEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true;
  }

  const value = raw.trim().toLowerCase();

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  // eslint-disable-next-line no-console
  console.warn(`Invalid MEAL_GATE_ENABLED value "${raw}", disabling meal gate.`);

  return false;
}

function parseGateThreshold(raw: string | undefined): number {
  const value = raw?.trim();

  if (value === undefined) {
    return 0.3;
  }

  const threshold = Number(value);

  if (value !== '' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
    return threshold;
  }

  // eslint-disable-next-line no-console
  console.warn(`Invalid MEAL_GATE_REJECT_THRESHOLD value "${raw}", using 0.30.`);

  return 0.3;
}

function parseAsaasWebhookAllowedIps(raw: string | undefined): string[] {
  const value = raw?.trim() ?? '';

  if (value === '*') {
    return [];
  }

  if (!value) {
    return ASAAS_WEBHOOK_PRODUCTION_IPS;
  }

  return value.split(',').map((ip) => ip.trim()).filter(Boolean);
}

namespace AppConfig {
  export type EnvAuth = {
    cognito: {
      clientId: string;
      userPoolId: string;
      clientSecret: string;
      userPooldomain: string;
    }
  }

  export type Db = {
    dynamodb: {
      mainTable: string;
      rateLimitTable: string;
    }
  }

  export type Storage = {
    mealsBucketName: string;
  }

  export type CDN = {
    mealsCDN: string;
  }

  export type Queue = {
    mealsQueueUrl: string;
    mealUploadCheckQueueUrl: string;
  }

  export type Billing = {
    asaas: {
      apiKey: string;
      webhookToken: string;
      baseUrl: string;
      webhookAllowedIps: string[];
    },
    appWebUrl: string;
  }

  export type AiGate = {
    enabled: boolean;
    rejectThreshold: number;
    accountId?: string;
    apiToken?: string;
  }
}
