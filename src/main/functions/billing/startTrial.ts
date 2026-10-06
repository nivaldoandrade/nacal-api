import 'reflect-metadata';

import { StartTrialController } from '@application/controllers/billing/StartTrialController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';
import '@main/di/bindings';

export const handler = lambdaHttpAdapter(StartTrialController);
