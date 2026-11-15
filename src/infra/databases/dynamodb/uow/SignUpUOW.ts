import { Account } from '@application/entities/Account';
import { Goal } from '@application/entities/Goal';
import { Profile } from '@application/entities/Profile';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { AccountsRepository } from '@infra/databases/dynamodb/AccountsRepository';
import { GoalRepository } from '@infra/databases/dynamodb/GoalRepository';
import { ProfileRepository } from '@infra/databases/dynamodb/ProfileRepository';
import { UnitOfWork } from '@infra/databases/dynamodb/uow/UnitOfWork';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class SignUpUOW extends UnitOfWork {
  constructor(
    private readonly accountsRepository: AccountsRepository,
    private readonly profileRepository: ProfileRepository,
    private readonly goalRepository: GoalRepository,
  ) {
    super();
  }

  async run(params: SignUpUOW.RunParams): Promise<boolean> {
    return this.write(params, true);
  }

  private async write(
    { account, goal, profile }: SignUpUOW.RunParams,
    retryOnConflict: boolean,
  ): Promise<boolean> {
    this.registerPut(this.accountsRepository.getOnboardingPutCommandInput(account));
    this.registerPut(this.profileRepository.getPutCommandInput(profile));
    this.registerPut(this.goalRepository.getPutCommandInput(goal));

    try {
      await this.commit();
      return true;
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }

      if (error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        return false;
      }

      const hasConflict = error.CancellationReasons?.some(
        (reason) => reason.Code === 'TransactionConflict',
      );

      if (hasConflict && retryOnConflict) {
        return this.write({ account, goal, profile }, false);
      }

      throw error;
    }
  }
}

namespace SignUpUOW {
  export type RunParams = {
    account: Account;
    profile: Profile;
    goal: Goal;
  }
}
