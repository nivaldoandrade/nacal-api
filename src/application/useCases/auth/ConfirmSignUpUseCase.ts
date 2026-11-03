import { InvalidConfirmationCode } from '@application/errors/application/InvalidConfirmationCode';
import { AccountProvisioningService } from '@application/services/AccountProvisioningService';
import { AccountsRepository } from '@infra/databases/dynamodb/AccountsRepository';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { normalizeEmail } from '@shared/utils/normalizeEmail';
import { CodeMismatchException, ExpiredCodeException, InvalidParameterException, NotAuthorizedException } from '@aws-sdk/client-cognito-identity-provider';

@Injectable()
export class ConfirmSignUpUseCase {

  constructor(
    private readonly authGateway: AuthGateway,
    private readonly accountsRepository: AccountsRepository,
    private readonly accountProvisioningService: AccountProvisioningService,
  ) { }

  async execute({ email, confirmationCode, password }: ConfirmSignUpUseCase.Input): Promise<ConfirmSignUpUseCase.Output> {
    const normalizedEmail = normalizeEmail(email);

    const user = await this.authGateway.getUserByEmail(normalizedEmail);

    if (!user) {
      throw new InvalidConfirmationCode();
    }

    if (user.status === 'CONFIRMED') {
      // The code can no longer be verified, so this request proves nothing about who sent it.
      // Never provision or apply the pending sign-up here; GET /me (after a password sign-in) or
      // the Google callback does that once the user proves ownership.
      await this.ensureAlreadyConfirmed(user.internalId);
      return { passwordResetRequired: false };
    }

    try {
      await this.authGateway.confirmSignUp({
        email: normalizedEmail,
        confirmationCode,
      });
    } catch (error) {
      if (
        error instanceof CodeMismatchException
        || error instanceof ExpiredCodeException
        || error instanceof InvalidParameterException
      ) {
        throw new InvalidConfirmationCode();
      }

      if (error instanceof NotAuthorizedException) {
        // Confirmed concurrently (double submit or Google sign-in).
        await this.ensureAlreadyConfirmed(user.internalId);
        return { passwordResetRequired: false };
      }

      throw error;
    }

    if (!user.internalId || !user.externalId) {
      throw new InvalidConfirmationCode();
    }

    // The code proves who owns the inbox, not who chose the password: anyone can sign up (or
    // re-submit a sign-up) for an email that is still unconfirmed. Only keep the password and the
    // pending profile if the person confirming knows the password.
    const passwordMatches = await this.passwordMatches(normalizedEmail, password);

    if (!passwordMatches) {
      await this.authGateway.invalidatePassword(user.username);
    }

    // If this fails, the user is confirmed without an Account; GET /me provisions it after the next sign-in.
    await this.accountProvisioningService.ensureAccount({
      email: normalizedEmail,
      internalId: user.internalId,
      externalId: user.externalId,
      skipPendingSignUp: !passwordMatches,
    });

    return { passwordResetRequired: !passwordMatches };
  }

  private async passwordMatches(email: string, password: string): Promise<boolean> {
    try {
      await this.authGateway.signIn({ email, password });
      return true;
    } catch {
      // Fail closed: on any failure (wrong password, throttling, timeout) the password is replaced
      // and the user recovers through forgot-password, which also requires the inbox.
      return false;
    }
  }

  private async ensureAlreadyConfirmed(internalId: string | null): Promise<void> {
    const account = internalId ? await this.accountsRepository.findById(internalId) : null;

    if (!account) {
      throw new InvalidConfirmationCode();
    }
  }
}

export namespace ConfirmSignUpUseCase {
  export type Input = {
    email: string;
    confirmationCode: string;
    password: string;
  };

  export type Output = {
    passwordResetRequired: boolean;
  };
}
