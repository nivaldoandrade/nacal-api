import { ApplicationError } from '@application/errors/application/ApplicationError';
import { EmailLinkedToGoogle } from '@application/errors/application/EmailLinkedToGoogle';
import { EmailNotConfirmed } from '@application/errors/application/EmailNotConfirmed';
import { InvalidCredentials } from '@application/errors/application/InvalidCredentials';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { NotAuthorizedException, UserNotConfirmedException } from '@aws-sdk/client-cognito-identity-provider';

@Injectable()
export class SignInUseCase {

  constructor(
    private readonly authGateway: AuthGateway,
  ) { }

  async execute(
    { email, password }: SignInUseCase.Input,
  ): Promise<SignInUseCase.Output> {
    try {
      const username = await this.authGateway.resolveUsername(email);

      return await this.authGateway.signIn({ email: username, password });
    } catch (error) {
      if (error instanceof UserNotConfirmedException) {
        throw new EmailNotConfirmed();
      }

      if (error instanceof ApplicationError) {
        throw error;
      }

      if (error instanceof NotAuthorizedException && await this.isLinkedToGoogle(email)) {
        throw new EmailLinkedToGoogle();
      }

      throw new InvalidCredentials();
    }
  }

  private async isLinkedToGoogle(email: string): Promise<boolean> {
    try {
      const username = await this.authGateway.resolveUsername(email);
      const user = await this.authGateway.getUserByEmail(username);

      return user?.linkedProviders.includes('Google') ?? false;
    } catch {
      return false;
    }
  }
}

namespace SignInUseCase {

  export type Input = {
    email: string;
    password: string;
  }

  export type Output = {
    accessToken: string;
    refreshToken: string;
  }
}
