import 'reflect-metadata';

import { CreateTextMealController } from '@application/controllers/meal/CreateTextMealController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(CreateTextMealController);
