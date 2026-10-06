import 'reflect-metadata';

import { CancelSubscriptionController } from '@application/controllers/billing/CancelSubscriptionController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';
import '@main/di/bindings';

export const handler = lambdaHttpAdapter(CancelSubscriptionController);
