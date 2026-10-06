import 'reflect-metadata';

import { CreateCheckoutController } from '@application/controllers/billing/CreateCheckoutController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';
import '@main/di/bindings';

export const handler = lambdaHttpAdapter(CreateCheckoutController);
