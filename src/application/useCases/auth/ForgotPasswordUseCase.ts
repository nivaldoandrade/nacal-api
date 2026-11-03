import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ForgotPasswordUseCase {

  constructor(private readonly authGateway: AuthGateway) { }

  async execute(email: string): Promise<void> {
    const username = await this.authGateway.resolveUsername(email);

    await this.authGateway.forgotPassword(username);
  }

}

