import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ConfirmationForgotPasswordUseCase {

  constructor(private readonly authGateway: AuthGateway) { }

  async execute(
    {
      email,
      password,
      confirmationCode,
    }: ConfirmationForgotPasswordUseCase.Input,
  ): Promise<void> {
    const username = await this.authGateway.resolveUsername(email);

    await this.authGateway.confirmForgotPassword({
      email: username,
      password,
      confirmationCode,
    });
  }
}

namespace ConfirmationForgotPasswordUseCase {
  export type Input = {
    email: string;
    password: string;
    confirmationCode: string;
  }
}
