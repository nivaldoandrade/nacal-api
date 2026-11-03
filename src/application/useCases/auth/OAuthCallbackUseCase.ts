import { InvalidOAuthGrant } from '@application/errors/application/InvalidOAuthGrant';
import { AccountProvisioningService } from '@application/services/AccountProvisioningService';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class OAuthCallbackUseCase {

  constructor(
    private readonly authGateway: AuthGateway,
    private readonly accountProvisioningService: AccountProvisioningService,
  ) { }

  async execute({
    code,
    redirect_uri,
    code_verifier,
  }: OAuthCallbackUseCase.Input): Promise<OAuthCallbackUseCase.Output> {
    const { accessToken, refreshToken } = await this.authGateway.exchangeCodeForTokens({
      code,
      redirect_uri,
      code_verifier,
    });

    const { email, externalId, internalId, emailVerified } = await this.authGateway.getUser(accessToken);

    if (!email || !externalId || !internalId) {
      throw new InvalidOAuthGrant('Missing user data from token.');
    }

    if (!emailVerified) {
      throw new InvalidOAuthGrant('Email is not verified.');
    }

    // Applies the PendingSignUp of a native user who skipped the email code and signed in with
    // Google instead (the PreSignUp trigger confirms them), so the onboarding data is kept.
    const account = await this.accountProvisioningService.ensureAccount({
      email,
      internalId,
      externalId,
    });

    return {
      isOnboarded: account.isOnboarded,
      accessToken,
      refreshToken,
    };
  }
}

export namespace OAuthCallbackUseCase {
  export type Input = {
    code: string;
    redirect_uri: string;
    code_verifier: string;
  }

  export type Output = {
    isOnboarded: boolean;
    accessToken: string;
    refreshToken: string;
  }
}
