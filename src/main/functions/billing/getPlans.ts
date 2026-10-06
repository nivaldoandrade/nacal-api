import 'reflect-metadata';

import { GetPlansController } from '@application/controllers/billing/GetPlansController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';
import '@main/di/bindings';

export const handler = lambdaHttpAdapter(GetPlansController);
