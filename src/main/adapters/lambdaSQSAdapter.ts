/* eslint-disable no-console */

import { ISQSHandler } from '@application/contracts/ISQSHandler';
import { Constructor, Registry } from '@kernel/di/Registry';
import { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';

export function lambdaSQSAdapter(eventHandlerImpl: Constructor<ISQSHandler>): SQSHandler {
  return async (event) => {
    const eventHandler = Registry.getInstance().resolver(eventHandlerImpl);

    const results = await Promise.allSettled(
      event.Records.map(async e => {
        const body = JSON.parse(e.body);

        await eventHandler.handle(body);
      }),
    );

    const batchItemFailures: SQSBatchItemFailure[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }

      const { messageId } = event.Records[index];

      console.error(`SQS message ${messageId} failed:`, result.reason);
      batchItemFailures.push({ itemIdentifier: messageId });
    });

    return { batchItemFailures };
  };
}
