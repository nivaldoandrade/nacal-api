import { IScheduleHandler } from '@application/contracts/IScheduleHandler';
import { Constructor, Registry } from '@kernel/di/Registry';
import { logger } from '@shared/logger/logger';
import { Handler } from 'aws-lambda';

export function lambdaScheduleAdapter<TOutput>(
  scheduleHandlerImpl: Constructor<IScheduleHandler<Record<string, unknown>, TOutput>>,
): Handler<Record<string, unknown> | undefined, TOutput> {
  return async (event, context) => {
    const scheduleHandler = Registry.getInstance().resolver(scheduleHandlerImpl);

    return logger.runWithContext(
      { awsRequestId: context?.awsRequestId },
      () => scheduleHandler.handle(event ?? {}),
    );
  };
}
