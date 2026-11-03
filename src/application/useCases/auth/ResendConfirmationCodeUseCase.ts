import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';
import { normalizeEmail } from '@shared/utils/normalizeEmail';

@Injectable()
export class ResendConfirmationCodeUseCase {

  constructor(
    private readonly authGateway: AuthGateway,
  ) { }

  async execute({ email }: ResendConfirmationCodeUseCase.Input): Promise<void> {
    const normalizedEmail = normalizeEmail(email);

    const user = await this.authGateway.getUserByEmail(normalizedEmail);

    if (!user || user.status !== 'UNCONFIRMED') {
      return;
    }

    await this.authGateway.resendConfirmationCode(normalizedEmail);
  }
}

namespace ResendConfirmationCodeUseCase {
  export type Input = {
    email: string;
  };
}
