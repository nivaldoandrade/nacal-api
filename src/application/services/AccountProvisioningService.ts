import { Account } from '@application/entities/Account';
import { Profile } from '@application/entities/Profile';
import { EmailAlreadyInUse } from '@application/errors/application/EmailAlreadyInUse';
import { GoalCalculator } from '@application/services/GoalCalculator';
import { AccountsRepository } from '@infra/databases/dynamodb/AccountsRepository';
import { PendingSignUpRepository } from '@infra/databases/dynamodb/PendingSignUpRepository';
import { SignUpUOW } from '@infra/databases/dynamodb/uow/SignUpUOW';
import { Injectable } from '@kernel/decorators/Injectable';

/**
 * Makes sure a Cognito user that has already proven ownership of the email (confirmation code,
 * password sign-in or Google) has an Account, applying the PendingSignUp collected during the
 * email sign-up when there is one. Idempotent, so any of those entry points can retry it after a
 * partial failure.
 */
@Injectable()
export class AccountProvisioningService {

  constructor(
    private readonly accountsRepository: AccountsRepository,
    private readonly pendingSignUpRepository: PendingSignUpRepository,
    private readonly signUpUOW: SignUpUOW,
  ) { }

  async ensureAccount({
    email,
    internalId,
    externalId,
    skipPendingSignUp = false,
  }: AccountProvisioningService.Input): Promise<Account> {
    // Look up by the immutable custom:internalId. The email comes from a Cognito attribute and is
    // only trusted to detect conflicts, never to pick which Account to return or overwrite.
    const existingAccount = await this.accountsRepository.findById(internalId);

    if (existingAccount?.isOnboarded) {
      return existingAccount;
    }

    if (!existingAccount) {
      const emailOwner = await this.accountsRepository.findByEmail(email);

      if (emailOwner && emailOwner.id !== internalId) {
        throw new EmailAlreadyInUse();
      }
    }

    let pendingSignUp = await this.pendingSignUpRepository.findByAccountId(internalId);

    if (pendingSignUp && skipPendingSignUp) {
      await this.deletePendingSignUp(pendingSignUp.accountId);
      pendingSignUp = null;
    }

    if (pendingSignUp && pendingSignUp.expiresAt <= Math.floor(Date.now() / 1000)) {
      await this.deletePendingSignUp(pendingSignUp.accountId);
      pendingSignUp = null;
    }

    if (!pendingSignUp) {
      if (existingAccount) {
        return existingAccount;
      }

      const account = new Account({
        id: internalId,
        email,
        externalId,
        isOnboarded: false,
      });

      await this.accountsRepository.create(account);

      return account;
    }

    const account = existingAccount ?? new Account({
      id: pendingSignUp.accountId,
      email,
      externalId,
      isOnboarded: true,
      termsAcceptedAt: pendingSignUp.termsAcceptedAt,
      termsVersion: pendingSignUp.termsVersion,
    });

    account.isOnboarded = true;
    account.termsAcceptedAt = pendingSignUp.termsAcceptedAt;
    account.termsVersion = pendingSignUp.termsVersion;

    const profile = new Profile({
      accountId: account.id,
      ...pendingSignUp.profile,
    });

    const goal = GoalCalculator.calculate(profile);

    await this.signUpUOW.run({ account, goal, profile });
    await this.deletePendingSignUp(pendingSignUp.accountId);

    return account;
  }

  private async deletePendingSignUp(accountId: string): Promise<void> {
    try {
      await this.pendingSignUpRepository.delete(accountId);
    } catch (error) {
      // The account is already provisioned; TTL cleans this up.
      // eslint-disable-next-line no-console
      console.error('Failed to delete pending sign-up:', error);
    }
  }
}

export namespace AccountProvisioningService {
  export type Input = {
    email: string;
    internalId: string;
    externalId: string;
    /** Discard the PendingSignUp instead of applying it (its author was not proven). */
    skipPendingSignUp?: boolean;
  };
}
