import { PendingSignUp } from '@application/entities/PendingSignUp';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { PendingSignUpItem } from '@infra/databases/dynamodb/items/PendingSignUpItem';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class PendingSignUpRepository {

  constructor(private readonly config: AppConfig) { }

  async create(pending: PendingSignUp): Promise<void> {
    const command = new PutCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Item: PendingSignUpItem.fromEntity(pending).getItem(),
    });

    await dynamodbClient.send(command);
  }

  async findByAccountId(accountId: string): Promise<PendingSignUp | null> {
    const command = new GetCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: PendingSignUpItem.getPK(accountId),
        SK: PendingSignUpItem.getSK(accountId),
      },
      ConsistentRead: true,
    });

    const { Item } = await dynamodbClient.send(command);

    if (!Item) {
      return null;
    }

    return PendingSignUpItem.toEntity(Item as PendingSignUpItem.Attributes);
  }

  async delete(accountId: string): Promise<void> {
    const command = new DeleteCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Key: {
        PK: PendingSignUpItem.getPK(accountId),
        SK: PendingSignUpItem.getSK(accountId),
      },
    });

    await dynamodbClient.send(command);
  }
}
