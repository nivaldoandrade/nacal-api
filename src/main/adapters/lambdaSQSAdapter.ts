import { ISQSHandler } from '@application/contracts/ISQSHandler';
import { Constructor, Registry } from '@kernel/di/Registry';
import { logger } from '@shared/logger/logger';
import { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';

export function lambdaSQSAdapter(eventHandlerImpl: Constructor<ISQSHandler>): SQSHandler {
  return async (event, context) => {
    const eventHandler = Registry.getInstance().resolver(eventHandlerImpl);

    const results = await Promise.allSettled(
      event.Records.map((record) => logger.runWithContext({
        awsRequestId: context?.awsRequestId,
        messageId: record.messageId,
        receiveCount: Number(record.attributes.ApproximateReceiveCount),
      }, async () => {
        try {
          const body = JSON.parse(record.body);

          await eventHandler.handle(body);
        } catch (error) {
          logger.error('sqs message failed', { error });

          throw error;
        }
      })),
    );

    const batchItemFailures: SQSBatchItemFailure[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }

      batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
    });

    return { batchItemFailures };
  };
}
