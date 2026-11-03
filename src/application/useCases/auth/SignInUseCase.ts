import { ApplicationError } from '@application/errors/application/ApplicationError';
import { EmailNotConfirmed } from '@application/errors/application/EmailNotConfirmed';
import { InvalidCredentials } from '@application/errors/application/InvalidCredentials';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { UserNotConfirmedException } from '@aws-sdk/client-cognito-identity-provider';

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

      throw new InvalidCredentials();
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
