import 'reflect-metadata';

import { RemoveMealItemController } from '@application/controllers/meal/RemoveMealItemController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(RemoveMealItemController);
