import { PendingSignUp } from '@application/entities/PendingSignUp';
import { Profile } from '@application/entities/Profile';
import { EmailAlreadyInUse } from '@application/errors/application/EmailAlreadyInUse';
import { AccountsRepository } from '@infra/databases/dynamodb/AccountsRepository';
import { PendingSignUpRepository } from '@infra/databases/dynamodb/PendingSignUpRepository';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { TERMS_VERSION } from '@shared/config/terms';
import { generateUniqueId } from '@shared/utils/generateUniqueId';
import { normalizeEmail } from '@shared/utils/normalizeEmail';
import { UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';

@Injectable()
export class SignUpUseCase {

  constructor(
    private readonly authGateway: AuthGateway,
    private readonly accountsRepository: AccountsRepository,
    private readonly pendingSignUpRepository: PendingSignUpRepository,
  ) { }

  async execute({ account: accountInput, profile: profileInput }: SignUpUseCase.Input,
  ): Promise<SignUpUseCase.Output> {

    const email = normalizeEmail(accountInput.email);
    const { password } = accountInput;

    const emailIsAlreadyInUse = await this.accountsRepository.findByEmail(email);

    if (emailIsAlreadyInUse) {
      throw new EmailAlreadyInUse();
    }

    try {
      await this.createPendingSignUp({ email, password, profile: profileInput });

      return {
        requiresConfirmation: true,
        alreadyPending: false,
      };
    } catch (error) {
      if (!(error instanceof UsernameExistsException)) {
        throw error;
      }
    }

    const existingUser = await this.authGateway.getUserByEmail(email);

    if (!existingUser || existingUser.status !== 'UNCONFIRMED') {
      throw new EmailAlreadyInUse();
    }

    // The previous attempt was never confirmed, so nothing else references it. Replace it so the
    // new password, profile and terms are the ones that take effect, with a fresh code and TTL.
    if (existingUser.internalId) {
      await this.pendingSignUpRepository.delete(existingUser.internalId).catch(() => undefined);
    }

    await this.authGateway.deleteUser(existingUser.username);

    try {
      await this.createPendingSignUp({ email, password, profile: profileInput });
    } catch (error) {
      if (error instanceof UsernameExistsException) {
        throw new EmailAlreadyInUse();
      }

      throw error;
    }

    return {
      requiresConfirmation: true,
      alreadyPending: true,
    };
  }

  private async createPendingSignUp({
    email,
    password,
    profile,
  }: {
    email: string;
    password: string;
    profile: SignUpUseCase.Input['profile'];
  }): Promise<void> {
    const accountId = generateUniqueId();

    const { externalId } = await this.authGateway.signUp({
      internalId: accountId,
      email,
      password,
      name: profile.name,
    });

    try {
      const pendingSignUp = new PendingSignUp({
        accountId,
        email,
        externalId,
        profile,
        termsVersion: TERMS_VERSION,
        termsAcceptedAt: new Date(),
        expiresAt: Math.floor(Date.now() / 1000) + (60 * 60 * 24),
      });

      await this.pendingSignUpRepository.create(pendingSignUp);
    } catch (error) {
      await this.authGateway.deleteUser(email).catch(() => undefined);

      throw error;
    }
  }
}

namespace SignUpUseCase {

  export type Input = {
    account: {
      email: string;
      password: string;
    },
    profile: {
      name: string;
      birthDate: Date;
      gender: Profile.Gender;
      height: number;
      weight: number;
      activityLevel: Profile.ActivityLevel;
      goal: Profile.Goal;
    }
  }

  export type Output = {
    requiresConfirmation: true;
    alreadyPending: boolean;
  }
}
