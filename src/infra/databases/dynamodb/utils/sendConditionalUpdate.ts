import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand, UpdateCommandOutput } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';

export async function sendConditionalUpdate(command: UpdateCommand): Promise<UpdateCommandOutput | null> {
  try {
    return await dynamodbClient.send(command);
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return null;
    }

    throw error;
  }
}

export async function sendConditional(command: UpdateCommand): Promise<boolean> {
  return (await sendConditionalUpdate(command)) !== null;
}
