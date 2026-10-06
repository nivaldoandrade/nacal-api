import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { $ZodError } from 'zod/v4/core';

import { Controller } from '@application/contracts/Controller';
import { ApplicationError } from '@application/errors/application/ApplicationError';
import { HttpError } from '@application/errors/http/HttpError';
import { RateLimitExceeded } from '@application/errors/http/RateLimitExceeded';
import { RateLimitService } from '@application/services/RateLimitService';
import { RateLimitRule, getRateLimitRules } from '@kernel/decorators/RateLimit';
import { Constructor, Registry } from '@kernel/di/Registry';
import { lambdaHttpBodyParser } from '@main/utils/lambdaHttpBodyParser';
import { lambdaHttpErrorResponse } from '@main/utils/lambdaHttpErrorResponse';
import { lambdaHttpResponse } from '@main/utils/lambdaHttpResponse';

type Event = APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer

export function lambdaHttpAdapter(controllerImpl: Constructor<Controller<'private' | 'public'>>) {
  return async (event: Event): Promise<APIGatewayProxyResultV2> => {
    try {
      const body = lambdaHttpBodyParser(event.body);
      const params = event.pathParameters ?? {};
      const queryParams = event.queryStringParameters ?? {};
      const headers = Object.fromEntries(
        Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const rawBody = event.body ?? undefined;

      const accountId = 'authorizer' in event.requestContext
        ? event.requestContext.authorizer.jwt.claims['internalId'] as string | undefined
        : undefined;

      if ('authorizer' in event.requestContext && !accountId) {
        return lambdaHttpErrorResponse({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Missing accountId claim.',
        });
      }

      const controller = Registry.getInstance().resolver(controllerImpl);

      const request = accountId
        ? { body, params, queryParams, headers, rawBody, accountId }
        : { body, params, queryParams, headers, rawBody };

      const rateLimitRules = getRateLimitRules(controller);

      if (rateLimitRules.length > 0) {
        const rateLimitService = Registry.getInstance().resolver(RateLimitService);

        for (const rule of rateLimitRules) {
          const key = resolveRateLimitKey(rule, request, event);

          if (!key) {
            continue;
          }

          try {
            await rateLimitService.check({
              key,
              scope: rule.scope,
              limit: rule.limit,
              windowSeconds: rule.windowSeconds,
            });
          } catch (error) {
            if (error instanceof RateLimitExceeded) {
              const retryAfter = rule.windowSeconds - (Math.floor(Date.now() / 1000) % rule.windowSeconds);

              return lambdaHttpErrorResponse({
                statusCode: error.statusCode,
                code: error.code,
                message: error.message,
                headers: {
                  'Retry-After': String(retryAfter),
                },
              });
            }

            throw error;
          }
        }
      }

      const {
        statusCode,
        body: resultBody,
      } = await controller.execute(request);

      return lambdaHttpResponse(statusCode, resultBody);

    } catch (error) {
      if (error instanceof $ZodError) {
        return lambdaHttpErrorResponse({
          statusCode: 400,
          code: 'VALIDATION',
          message: error.issues.map(error => ({
            field: error.path.join('.'),
            error: error.message,
          })),
        });
      }

      if (error instanceof HttpError) {
        return lambdaHttpErrorResponse(error);
      }

      if (error instanceof ApplicationError) {
        return lambdaHttpErrorResponse({
          statusCode: error.statusCode ?? 400,
          code: error.code,
          message: error.message,
        });
      }

      console.error(error);

      return lambdaHttpErrorResponse({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      });
    }
  };
}

function resolveRateLimitKey(
  rule: RateLimitRule,
  request: Controller.Request<'private' | 'public'>,
  event: Event,
): string | undefined {
  switch (rule.scope) {
    case 'ip':
      return `${event.routeKey}#${event.requestContext.http.sourceIp}`;
    case 'account':
      return 'accountId' in request ? `${event.routeKey}#${request.accountId}` : undefined;
    case 'email': {
      const email = request.body?.[rule.field ?? 'email'];
      return typeof email === 'string' ? email.toLowerCase() : undefined;
    }
    default:
      return undefined;
  }

}
