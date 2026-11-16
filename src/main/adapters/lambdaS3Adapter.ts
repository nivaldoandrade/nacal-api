import { IEventHandler } from '@application/contracts/IEventHandler';
import { Constructor, Registry } from '@kernel/di/Registry';
import { logger } from '@shared/logger/logger';
import { S3Handler } from 'aws-lambda';

export function lambdaS3Adapter(eventHandlerImpl: Constructor<IEventHandler>): S3Handler {
  return async (event, context) => {
    const eventHandler = Registry.getInstance().resolver(eventHandlerImpl);

    await Promise.allSettled(event.Records.map((record) => logger.runWithContext({
      awsRequestId: context?.awsRequestId,
      fileKey: record.s3.object.key,
    }, async () => {
      try {
        await eventHandler.handle({ fileKey: record.s3.object.key });
      } catch (error) {
        logger.error('s3 event failed', { error });
      }
    })));
  };
}
