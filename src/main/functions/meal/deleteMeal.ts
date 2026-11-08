import 'reflect-metadata';

import { DeleteMealController } from '@application/controllers/meal/DeleteMealController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(DeleteMealController);
