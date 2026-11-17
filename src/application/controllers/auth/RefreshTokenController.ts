import { Controller } from '@application/contracts/Controller';
import { RefreshTokenBody, refreshTokenSchema } from '@application/controllers/auth/schemas/refreshTokenSchema';
import { RefreshTokenUseCase } from '@application/useCases/auth/RefreshTokenUseCase';
import { Injectable } from '@kernel/decorators/Injectable';
import { RateLimit } from '@kernel/decorators/RateLimit';
import { Schema } from '@kernel/decorators/Schema';

@Injectable()
@Schema(refreshTokenSchema)
@RateLimit({ scope: 'ip', limit: 300, windowSeconds: 900 })
@RateLimit({ scope: 'token', field: 'refreshToken', limit: 10, windowSeconds: 900 })
export class RefreshTokenController extends Controller<'public'> {

  constructor(private readonly refreshTokenUseCase: RefreshTokenUseCase) {
    super();
  }

  protected async handler(
    request: Controller.RequestPublic<RefreshTokenBody>,
  ): Promise<Controller.Response<RefreshTokenController.Response>> {
    const { refreshToken } = request.body;

    const {
      newAccessToken,
      newRefreshToken,
    } = await this.refreshTokenUseCase.execute(refreshToken);

    return {
      statusCode: 200,
      body: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    };
  }
}

namespace RefreshTokenController {
  export type Response = {
    accessToken: string;
    refreshToken: string;
  }
}
