import { Profile } from '@application/entities/Profile';
import { EmailAlreadyInUse } from '@application/errors/application/EmailAlreadyInUse';
import { InvalidOAuthGrant } from '@application/errors/application/InvalidOAuthGrant';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { GoalCalculator } from '@application/services/GoalCalculator';
import { AccountsRepository } from '@infra/databases/dynamodb/AccountsRepository';
import { SignUpUOW } from '@infra/databases/dynamodb/uow/SignUpUOW';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { TERMS_VERSION } from '@shared/config/terms';

@Injectable()
export class CompleteOnboardingUseCase {

  constructor(
    private readonly authGateway: AuthGateway,
    private readonly accountRepository: AccountsRepository,
    private readonly signUpUOW: SignUpUOW,
  ) { }

  async execute(input: CompleteOnboardingUseCase.Input) {
    const { accessToken, ...profileInput } = input;

    const {
      name,
      email,
      externalId,
    } = await this.authGateway.getUser(accessToken);

    if (!name || !email || !externalId) {
      throw new InvalidOAuthGrant('Missing user data from token.');
    }

    const existingAccount = await this.accountRepository.findByEmail(email);

    if (!existingAccount) {
      throw new ResourceNotFound('Account not found.');
    }

    if (existingAccount.externalId !== externalId) {
      throw new EmailAlreadyInUse();
    }

    const profile = new Profile({
      accountId: existingAccount.id,
      ...profileInput,
      name,
    });

    const goal = GoalCalculator.calculate(profile);

    existingAccount.isOnboarded = true;
    existingAccount.termsAcceptedAt = new Date();
    existingAccount.termsVersion = TERMS_VERSION;

    await this.signUpUOW.run({ account: existingAccount, goal, profile });
  }
}

namespace CompleteOnboardingUseCase {

  export type Input = {
    accessToken: string;
    birthDate: Date;
    gender: Profile.Gender;
    height: number;
    weight: number;
    activityLevel: Profile.ActivityLevel;
    goal: Profile.Goal;
  }
}
