import { Injectable } from '@kernel/decorators/Injectable';
import { env } from '@shared/config/env';

@Injectable()
export class AppConfig {
  readonly envAuth: AppConfig.EnvAuth;

  readonly db: AppConfig.Db;

  readonly storage: AppConfig.Storage;

  readonly cdn: AppConfig.CDN;

  readonly queue: AppConfig.Queue;

  readonly billing: AppConfig.Billing;

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
    };

    this.billing = {
      asaas: {
        apiKey: env.ASAAS_API_KEY,
        baseUrl: env.ASAAS_BASE_URL,
        webhookToken: env.ASAAS_WEBHOOK_TOKEN,
      },
      appWebUrl: env.APP_WEB_URL,
    };
  }

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
  }

  export type Billing = {
    asaas: {
      apiKey: string;
      webhookToken: string;
      baseUrl: string;
    },
    appWebUrl: string;
  }
}
