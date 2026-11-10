import 'reflect-metadata';

import { ReconcilePaymentsScheduleHandler } from '@application/schedules/ReconcilePaymentsScheduleHandler';
import { lambdaScheduleAdapter } from '@main/adapters/lambdaScheduleAdapter';
import '@main/di/bindings';

export const handler = lambdaScheduleAdapter(ReconcilePaymentsScheduleHandler);
