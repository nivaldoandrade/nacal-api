import 'reflect-metadata';

import { MealUploadCheckQueueConsumer } from '@application/queues/MealUploadCheckQueueConsumer';
import { lambdaSQSAdapter } from '@main/adapters/lambdaSQSAdapter';

export const handler = lambdaSQSAdapter(MealUploadCheckQueueConsumer);
