import 'reflect-metadata';

import { RestoreMealItemController } from '@application/controllers/meal/RestoreMealItemController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(RestoreMealItemController);
