import 'reflect-metadata';

import { AsaasWebhookController } from '@application/controllers/billing/AsaasWebhookController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';
import '@main/di/bindings';

export const handler = lambdaHttpAdapter(AsaasWebhookController);
