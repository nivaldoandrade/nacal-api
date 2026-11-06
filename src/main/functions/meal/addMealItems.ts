import 'reflect-metadata';

import { AddMealItemsController } from '@application/controllers/meal/AddMealItemsController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(AddMealItemsController);
