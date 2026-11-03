import { createHmac, randomBytes } from 'node:crypto';

import { CodeDeliveryFailed } from '@application/errors/application/CodeDeliveryFailed';
import { InvalidOAuthGrant } from '@application/errors/application/InvalidOAuthGrant';
import { TooManyAttempts } from '@application/errors/application/TooManyAttempts';
import { AdminDeleteUserCommand, AdminSetUserPasswordCommand, AdminGetUserCommand, CodeDeliveryFailureException, ConfirmForgotPasswordCommand, ConfirmSignUpCommand, ForgotPasswordCommand, GetTokensFromRefreshTokenCommand, GetUserCommand, InitiateAuthCommand, LimitExceededException, NotAuthorizedException, ResendConfirmationCodeCommand, SignUpCommand, TooManyFailedAttemptsException, TooManyRequestsException, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { cognitoClient } from '@infra/clients/cognitoClient';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';
import { normalizeEmail } from '@shared/utils/normalizeEmail';

@Injectable()
export class AuthGateway {

  constructor(
    private readonly config: AppConfig,
  ) { }

  async exchangeCodeForTokens({
    code,
    redirect_uri,
    code_verifier,
  }: AuthGateway.ExchangeCodeForTokens['params'],
  ): Promise<AuthGateway.ExchangeCodeForTokens['result']> {
    const authorizationToken = Buffer.from(
      `${this.config.envAuth.cognito.clientId}:${this.config.envAuth.cognito.clientSecret}`,
    ).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri,
      code,
      code_verifier,
    });

    const response = await fetch(`${this.config.envAuth.cognito.userPooldomain}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authorizationToken}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new InvalidOAuthGrant('Error while exchanging code.');
    }

    const { access_token, refresh_token } = await response.json() as AuthGateway.ExchangeCodeForTokens['fetchResponse'];

    if (!access_token || !refresh_token) {
      throw new InvalidOAuthGrant('Cognito token response is missing tokens.');
    }

    return {
      accessToken: access_token,
      refreshToken: refresh_token,
    };
  }

  async getUser(accessToken: string) {
    const command = new GetUserCommand({
      AccessToken: accessToken,
    });

    let userAttributes: AuthGateway.UserAttributes;

    try {
      const { UserAttributes } = await cognitoClient.send(command);
      userAttributes = UserAttributes;
    } catch (error) {
      if (error instanceof NotAuthorizedException) {
        throw new InvalidOAuthGrant('Invalid or expired access token.');
      }

      throw error;
    }

    const attrs = Object.fromEntries(
      userAttributes?.map(({ Name, Value }) => [Name, Value ?? null]) ?? [],
    ) as Record<string, string | null>;

    return {
      name: attrs['name'] ?? null,
      email: attrs['email'] ?? null,
      externalId: attrs['sub'] ?? null,
      internalId: attrs['custom:internalId'] ?? null,
      emailVerified: attrs['email_verified'] === 'true',
    };
  }

  async signIn({ email, password }: AuthGateway.SignIn['params']): Promise<AuthGateway.SignIn['result']> {
    const command = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: this.config.envAuth.cognito.clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        SECRET_HASH: this.getSecretHash(email),
      },

    });

    const { AuthenticationResult } = await mapThrottling(cognitoClient.send(command));

    if (!AuthenticationResult?.AccessToken || !AuthenticationResult.RefreshToken) {
      throw new Error(`Error signin user: ${email}`);
    }

    return {
      accessToken: AuthenticationResult.AccessToken,
      refreshToken: AuthenticationResult.RefreshToken,
    };

  }

  async signUp(
    params: AuthGateway.SignUp['params'],
  ): Promise<AuthGateway.SignUp['result']> {
    const { internalId, email, password, name } = params;

    const command = new SignUpCommand({
      ClientId: this.config.envAuth.cognito.clientId,
      Username: email,
      Password: password,
      SecretHash: this.getSecretHash(email),
      UserAttributes: [
        {
          Name: 'custom:internalId',
          Value: internalId,
        },
        {
          Name: 'name',
          Value: name,
        },
        {
          Name: 'email',
          Value: email,
        },
      ],
    });

    const { UserSub: externalId } = await mapThrottling(cognitoClient.send(command));

    if (!externalId) {
      throw new Error(`Error signup user: ${email}`);
    }

    return {
      externalId,
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthGateway.SignIn['result']> {
    const getTokensCommand = new GetTokensFromRefreshTokenCommand({
      RefreshToken: refreshToken,
      ClientId: this.config.envAuth.cognito.clientId,
      ClientSecret: this.config.envAuth.cognito.clientSecret,
    });

    const { AuthenticationResult } = await cognitoClient.send(getTokensCommand);

    if (!AuthenticationResult?.AccessToken || !AuthenticationResult.RefreshToken) {
      throw new Error('rror refresh token user.');
    }

    return {
      accessToken: AuthenticationResult.AccessToken,
      refreshToken: AuthenticationResult.RefreshToken,
    };
  }

  async forgotPassword(email: string): Promise<void> {
    const command = new ForgotPasswordCommand({
      ClientId: this.config.envAuth.cognito.clientId,
      Username: email,
      SecretHash: this.getSecretHash(email),
    });

    await mapThrottling(cognitoClient.send(command));
  }

  async confirmForgotPassword(
    {
      email,
      password,
      confirmationCode,
    }: AuthGateway.ConfirmForgotPassword['params'],
  ): Promise<void> {
    const command = new ConfirmForgotPasswordCommand({
      ClientId: this.config.envAuth.cognito.clientId,
      SecretHash: this.getSecretHash(email),
      Username: email,
      Password: password,
      ConfirmationCode: confirmationCode,
    });

    await mapThrottling(cognitoClient.send(command));
  }

  /** Replaces the password with a random one nobody knows; recovery is via forgot-password. */
  async invalidatePassword(username: string): Promise<void> {
    const command = new AdminSetUserPasswordCommand({
      UserPoolId: this.config.envAuth.cognito.userPoolId,
      Username: username,
      Password: `${randomBytes(24).toString('base64url')}aA1!`,
      Permanent: true,
    });

    await cognitoClient.send(command);
  }

  async deleteUser(email: string) {
    const command = new AdminDeleteUserCommand({
      UserPoolId: this.config.envAuth.cognito.userPoolId,
      Username: email,
    });

    await cognitoClient.send(command);
  }

  async getUserByEmail(email: string): Promise<AuthGateway.AdminUser | null> {
    const command = new AdminGetUserCommand({
      UserPoolId: this.config.envAuth.cognito.userPoolId,
      Username: email,
    });

    try {
      const { UserAttributes, UserStatus, Username } = await cognitoClient.send(command);

      const attrs = Object.fromEntries(
        UserAttributes?.map(({ Name, Value }) => [Name, Value ?? null]) ?? [],
      ) as Record<string, string | null>;

      return {
        username: Username ?? email,
        email: attrs['email'] ?? email,
        name: attrs['name'] ?? null,
        externalId: attrs['sub'] ?? null,
        internalId: attrs['custom:internalId'] ?? null,
        status: UserStatus ?? null,
      };
    } catch (error) {
      if (error instanceof UserNotFoundException) {
        return null;
      }

      throw error;
    }
  }

  async confirmSignUp({ email, confirmationCode }: AuthGateway.ConfirmSignUp['params']): Promise<void> {
    const command = new ConfirmSignUpCommand({
      ClientId: this.config.envAuth.cognito.clientId,
      Username: email,
      ConfirmationCode: confirmationCode,
      SecretHash: this.getSecretHash(email),
    });

    await mapThrottling(cognitoClient.send(command));
  }

  async resendConfirmationCode(email: string): Promise<void> {
    const command = new ResendConfirmationCodeCommand({
      ClientId: this.config.envAuth.cognito.clientId,
      Username: email,
      SecretHash: this.getSecretHash(email),
    });

    await mapThrottling(cognitoClient.send(command));
  }

  /**
   * The user pool is case-sensitive. New users are stored with a normalized (lowercase) email,
   * but users created before normalization may still be stored with the casing they typed.
   * Prefer the normalized username and fall back to the raw input only when it exists.
   */
  async resolveUsername(email: string): Promise<string> {
    const normalized = normalizeEmail(email);
    const raw = email.trim();

    if (normalized === raw || await this.getUserByEmail(normalized)) {
      return normalized;
    }

    return (await this.getUserByEmail(raw)) ? raw : normalized;
  }

  private getSecretHash(email: string): string {
    const clientId = this.config.envAuth.cognito.clientId;
    const clientSecret = this.config.envAuth.cognito.clientSecret;

    return createHmac('SHA256', clientSecret)
      .update(`${email}${clientId}`)
      .digest('base64');
  }
}

async function mapThrottling<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (
      error instanceof LimitExceededException
      || error instanceof TooManyFailedAttemptsException
      || error instanceof TooManyRequestsException
    ) {
      throw new TooManyAttempts();
    }

    if (error instanceof CodeDeliveryFailureException) {
      throw new CodeDeliveryFailed();
    }

    throw error;
  }
}

namespace AuthGateway {
  export type ExchangeCodeForTokens = {
    params: {
      code: string;
      redirect_uri: string;
      code_verifier: string;
    },
    fetchResponse: {
      access_token?: string;
      refresh_token?: string;
    },
    result: {
      accessToken: string;
      refreshToken: string;
    }
  }

  export type UserAttributes = { Name?: string; Value?: string }[] | undefined;

  export type SignUp = {
    params: {
      internalId: string;
      email: string;
      password: string;
      name: string;
    },
    result: {
      externalId: string;
    }
  }

  export type AdminUser = {
    username: string;
    email: string | null;
    name: string | null;
    externalId: string | null;
    internalId: string | null;
    status: string | null;
  }

  export type ConfirmSignUp = {
    params: {
      email: string;
      confirmationCode: string;
    }
  }

  export type SignIn = {
    params: {
      email: string;
      password: string;
    },
    result: {
      accessToken: string;
      refreshToken: string;
    }
  }

  export type ConfirmForgotPassword = {
    params: {
      email: string;
      password: string;
      confirmationCode: string;
    }
  }
}
