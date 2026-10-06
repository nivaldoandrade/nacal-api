import { Controller } from '@application/contracts/Controller';
import { WebhookUseCase } from '@application/useCases/billing/WebhookUseCase';
import { Injectable } from '@kernel/decorators/Injectable';

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
