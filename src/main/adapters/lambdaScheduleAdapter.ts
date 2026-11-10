import { IScheduleHandler } from '@application/contracts/IScheduleHandler';
import { Constructor, Registry } from '@kernel/di/Registry';
import { Handler } from 'aws-lambda';

export function lambdaScheduleAdapter<TOutput>(
  scheduleHandlerImpl: Constructor<IScheduleHandler<Record<string, unknown>, TOutput>>,
): Handler<Record<string, unknown> | undefined, TOutput> {
  return async (event) => {
    const scheduleHandler = Registry.getInstance().resolver(scheduleHandlerImpl);

    return scheduleHandler.handle(event ?? {});
  };
}
