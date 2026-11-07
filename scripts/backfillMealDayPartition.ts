/* eslint-disable no-console */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MealItem } from '@infra/databases/dynamodb/items/MealItem';

const args = process.argv.slice(2);
const tableArg = args.find(arg => arg.startsWith('--table='));
const tableName = tableArg?.split('=')[1];
const apply = args.includes('--apply');

if (!tableName) {
  throw new Error('Usage: npx tsx scripts/backfillMealDayPartition.ts --table=<TableName> [--apply]');
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type ScannedMeal = {
  PK: string;
  SK: string;
  accountId: string;
  createdAt: string;
  timeZone?: string;
  GSI1PK: string;
};

async function main() {
  console.log(`Table: ${tableName} | mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  let lastKey: Record<string, unknown> | undefined;
  let scanned = 0;
  let changed = 0;

  do {
    const { Items = [], LastEvaluatedKey } = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: '#type = :type',
      ProjectionExpression: '#PK, #SK, #accountId, #createdAt, #timeZone, #GSI1PK',
      ExpressionAttributeNames: {
        '#type': 'type',
        '#PK': 'PK',
        '#SK': 'SK',
        '#accountId': 'accountId',
        '#createdAt': 'createdAt',
        '#timeZone': 'timeZone',
        '#GSI1PK': 'GSI1PK',
      },
      ExpressionAttributeValues: { ':type': MealItem.TYPE },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of Items as ScannedMeal[]) {
      scanned++;

      const expected = MealItem.GSI1PK({
        accountId: item.accountId,
        day: MealItem.getDay(new Date(item.createdAt), item.timeZone),
      });

      if (expected === item.GSI1PK) {
        continue;
      }

      changed++;
      console.log(`${item.PK} | createdAt=${item.createdAt} tz=${item.timeZone || '-'} | ${item.GSI1PK} -> ${expected}`);

      if (apply) {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: 'SET #GSI1PK = :expected',
          ConditionExpression: '#GSI1PK = :current',
          ExpressionAttributeNames: { '#GSI1PK': 'GSI1PK' },
          ExpressionAttributeValues: { ':expected': expected, ':current': item.GSI1PK },
        }));
      }
    }

    lastKey = LastEvaluatedKey;
  } while (lastKey);

  console.log(`Scanned: ${scanned} | ${apply ? 'updated' : 'would update'}: ${changed}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
