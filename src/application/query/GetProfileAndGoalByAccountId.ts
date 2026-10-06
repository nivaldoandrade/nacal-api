import { Profile } from '@application/entities/Profile';
import { Subscription } from '@application/entities/Subscription';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodbClient } from '@infra/clients/dynamodbClient';
import { AccountItem } from '@infra/databases/dynamodb/items/AccountItem';
import { GoalItem } from '@infra/databases/dynamodb/items/GoalItem';
import { ProfileItem } from '@infra/databases/dynamodb/items/ProfileItem';
import { SubscriptionItem } from '@infra/databases/dynamodb/items/SubscriptionItem';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class GetProfileAndGoalByAccountId {

  constructor(private readonly config: AppConfig) { }

  async execute(
    accountId: string,
  ): Promise<GetProfileAndGoalByAccountId.Output> {
    const PK = AccountItem.getPK(accountId);

    const command = new QueryCommand({
      TableName: this.config.db.dynamodb.mainTable,
      Limit: 5,
      Select: 'SPECIFIC_ATTRIBUTES',
      ProjectionExpression: '#isOnboarded, #name, #birthDate, #gender, #height, #weight, #goal, #calories, #proteins, #carbohydrates, #fats, #type, #status, #planId, #trialEndsAt, #paidUntil',
      KeyConditionExpression: '#PK = :PK AND begins_with(#SK, :SK)',
      ExpressionAttributeNames: {
        '#PK': 'PK',
        '#SK': 'SK',
        '#isOnboarded': 'isOnboarded',
        '#name': 'name',
        '#birthDate': 'birthDate',
        '#gender': 'gender',
        '#height': 'height',
        '#weight': 'weight',
        '#goal': 'goal',
        '#calories': 'calories',
        '#proteins': 'proteins',
        '#carbohydrates': 'carbohydrates',
        '#fats': 'fats',
        '#type': 'type',
        '#status': 'status',
        '#planId': 'planId',
        '#trialEndsAt': 'trialEndsAt',
        '#paidUntil': 'paidUntil',
      },
      ExpressionAttributeValues: {
        ':PK': PK,
        ':SK': PK,
      },
    });

    const { Items = [] } = await dynamodbClient.send(command);

    const account = Items.find((item): item is GetProfileAndGoalByAccountId.AccountItemType => (
      item.type === AccountItem.TYPE
    ));

    if (!account) {
      throw new ResourceNotFound('Account not found.');
    }

    const profile = Items.find((item): item is GetProfileAndGoalByAccountId.ProfileItemType => (
      item.type === ProfileItem.TYPE
    ));

    const goal = Items.find((item): item is GetProfileAndGoalByAccountId.GoalItemType => (
      item.type === GoalItem.TYPE
    ));

    const subscription = Items.find((item): item is GetProfileAndGoalByAccountId.SubscriptionItemType => (
      item.type === SubscriptionItem.TYPE
    ));

    const { type: _accountType, isOnboarded } = account;

    let profileOutput: GetProfileAndGoalByAccountId.ProfileOutput | null = null;
    if (profile) {
      const { type: _profileType, ...restProfile } = profile;
      profileOutput = restProfile;
    }

    let goalOutput: GetProfileAndGoalByAccountId.GoalOutput | null = null;
    if (goal) {
      const { type: _goalType, ...restGoal } = goal;
      goalOutput = restGoal;
    }

    let subscriptionOutput: GetProfileAndGoalByAccountId.SubscriptionOutput | null = null;
    if (subscription) {
      const { type: _subscriptionType, ...restSubscription } = subscription;
      subscriptionOutput = restSubscription;
    }

    return {
      isOnboarded,
      profile: profileOutput,
      goal: goalOutput,
      subscription: subscriptionOutput,
    };
  }
}

export namespace GetProfileAndGoalByAccountId {

  export type AccountItemType = Pick<
    AccountItem.Item,
    'isOnboarded' | 'type'
  >;

  export type ProfileOutput = {
    name: string;
    birthDate: string;
    gender: string;
    height: number;
    weight: number;
    goal: Profile.Goal;
  }

  export type GoalOutput = {
    calories: number;
    proteins: number;
    carbohydrates: number;
    fats: number;
  }

  export type ProfileItemType = Pick<
    ProfileItem.ItemType,
    keyof ProfileOutput | 'type'
  >;

  export type GoalItemType = Pick<
    GoalItem.ItemType,
    keyof GoalOutput | 'type'
  >;

  export type SubscriptionOutput = {
    status: Subscription.StatusType;
    planId: Subscription.PlanIdType;
    trialEndsAt?: string;
    paidUntil?: string;
  }

  export type SubscriptionItemType = Pick<
    SubscriptionItem.ItemType,
    keyof SubscriptionOutput | 'type'
  >;

  export type Output = {
    isOnboarded: boolean;
    profile: ProfileOutput | null;
    goal: GoalOutput | null;
    subscription: SubscriptionOutput | null;
  }
}
