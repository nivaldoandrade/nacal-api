import { getSchema } from '@kernel/decorators/Schema';

type RouteType = 'public' | 'private';

export abstract class Controller<TType extends RouteType> {
  protected abstract handler(
    request: Controller.Request<TType>
  ): Promise<Controller.Response>;

  public async execute(request: Controller.Request<TType>): Promise<Controller.Response> {
    const body = this.validateBody(request.body);

    return this.handler({ ...request, body });
  }

  private validateBody(body: Controller.Request<TType>['body']) {
    const schema = getSchema(this);

    if (!schema) {
      return body;
    }

    return schema.parse(body);
  }
}

export namespace Controller {
  export type RequestBase<
    TBody = Record<string, unknown>,
    TParams = Record<string, unknown>,
    TQueryParams = Record<string, unknown>,
  > = {
    body: TBody;
    params: TParams;
    queryParams: TQueryParams;
    headers: Record<string, string | undefined>;
    rawBody?: string;
  };

  export type RequestPublic<
    TBody = Record<string, unknown>,
    TParams = Record<string, unknown>,
    TQueryParams = Record<string, unknown>
  > = RequestBase<TBody, TParams, TQueryParams>

  export type RequestPrivate<
    TBody = Record<string, unknown>,
    TParams = Record<string, unknown>,
    TQueryParams = Record<string, unknown>
  > = RequestBase<TBody, TParams, TQueryParams> & {
    accountId: string;
  }

  export type Request<
    TType extends RouteType,
    TBody = Record<string, unknown>,
    TParams = Record<string, unknown>,
    TQueryParams = Record<string, unknown>,
  > = TType extends 'private'
    ? RequestPrivate<TBody, TParams, TQueryParams>
    : RequestPublic<TBody, TParams, TQueryParams>

  export type Response<TBody = Record<string, unknown>> = {
    statusCode: number;
    body?: TBody;
  };
}
