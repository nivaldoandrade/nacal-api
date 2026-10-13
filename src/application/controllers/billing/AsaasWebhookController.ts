import { Controller } from '@application/contracts/Controller';
import { WebhookUseCase } from '@application/useCases/billing/WebhookUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { IpAllowlist } from '@kernel/decorators/IpAllowlist';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { AppConfig } from '@shared/config/AppConfig';

@IpAllowlist((config: AppConfig) => config.billing.asaas.webhookAllowedIps)
@RateLimit({ scope: 'ip', limit: 120, windowSeconds: 60 })
@Injectable()
export class AsaasWebhookController extends Controller<'public'> {

  constructor(private readonly webhookUseCase: WebhookUseCase) {
    super();
  }

  protected async handler(request: Controller.RequestPublic): Promise<Controller.Response<AsaasWebhookController.Response>> {
    const { handled } = await this.webhookUseCase.execute({
      headers: request.headers,
      rawBody: request.rawBody ?? '{}',
    });

    return {
      statusCode: 200,
      body: { received: handled },
    };
  }
}

namespace AsaasWebhookController {
  export type Response = {
    received: boolean;
  }
}
