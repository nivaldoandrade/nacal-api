import {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { $ZodError } from 'zod/v4/core';

import { Controller } from '@application/contracts/Controller';
import { ErrorCode } from '@application/errors/ErrorCode';
import { ApplicationError } from '@application/errors/application/ApplicationError';
import { HttpError } from '@application/errors/http/HttpError';
import { RateLimitExceeded } from '@application/errors/http/RateLimitExceeded';
import { RateLimitService } from '@application/services/RateLimitService';
import { RateLimitRule, getRateLimitRules } from '@kernel/decorators/RateLimit';
import { getIpAllowlist } from '@kernel/decorators/IpAllowlist';
import { getNon2xxMetric } from '@kernel/decorators/Non2xxMetric';
import { Constructor, Registry } from '@kernel/di/Registry';
import { lambdaHttpBodyParser } from '@main/utils/lambdaHttpBodyParser';
import { lambdaHttpErrorResponse } from '@main/utils/lambdaHttpErrorResponse';
import { lambdaHttpResponse } from '@main/utils/lambdaHttpResponse';
import { AppConfig } from '@shared/config/AppConfig';
import { logger } from '@shared/logger/logger';

type Event = APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer

type HttpResult = {
  response: APIGatewayProxyStructuredResultV2;
  errorCode?: ErrorCode;
  error?: unknown;
}

type ControllerImpl = Constructor<Controller<'private' | 'public'>>

export function lambdaHttpAdapter(controllerImpl: ControllerImpl) {
  const non2xxMetric = getNon2xxMetric(controllerImpl);

  return (event: Event, context?: Context): Promise<APIGatewayProxyResultV2> => {
    const startedAt = Date.now();
    const accountId = resolveAccountId(event);

    return logger.runWithContext({
      awsRequestId: context?.awsRequestId,
      routeKey: event.routeKey,
      accountId,
    }, async () => {
      const { response, errorCode, error } = await handleRequest(controllerImpl, event, accountId);
      const statusCode = response.statusCode ?? 200;

      logRequest({
        statusCode,
        durationMs: Date.now() - startedAt,
        errorCode,
        error,
      });

      if (non2xxMetric && (statusCode < 200 || statusCode >= 300)) {
        logger.metric(non2xxMetric, { statusCode, errorCode });
      }

      return response;
    });
  };
}

async function handleRequest(
  controllerImpl: ControllerImpl,
  event: Event,
  accountId: string | undefined,
): Promise<HttpResult> {
  try {
    const body = lambdaHttpBodyParser(event.body);
    const params = event.pathParameters ?? {};
    const queryParams = event.queryStringParameters ?? {};
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const rawBody = event.body ?? undefined;

    if ('authorizer' in event.requestContext && !accountId) {
      return errorResult({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Missing accountId claim.',
      });
    }

    const controller = Registry.getInstance().resolver(controllerImpl);

    const ipAllowlist = getIpAllowlist(controller);

    if (ipAllowlist) {
      const appConfig = Registry.getInstance().resolver(AppConfig);
      const allowedIps = ipAllowlist(appConfig);

      if (allowedIps.length > 0 && !allowedIps.includes(resolveClientIp(event))) {
        return errorResult({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'IP not allowed.',
        });
      }
    }

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

            return errorResult({
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

    return { response: lambdaHttpResponse(statusCode, resultBody) };

  } catch (error) {
    if (error instanceof $ZodError) {
      return errorResult({
        statusCode: 400,
        code: 'VALIDATION',
        message: error.issues.map(error => ({
          field: error.path.join('.'),
          error: error.message,
        })),
      });
    }

    if (error instanceof HttpError) {
      return errorResult(error);
    }

    if (error instanceof ApplicationError) {
      const statusCode = error.statusCode ?? 400;

      return {
        ...errorResult({
          statusCode,
          code: error.code,
          message: error.message,
        }),
        error: statusCode >= 500 ? error : undefined,
      };
    }

    return {
      ...errorResult({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      }),
      error,
    };
  }
}

function errorResult(params: Parameters<typeof lambdaHttpErrorResponse>[0]): HttpResult {
  return {
    response: lambdaHttpErrorResponse(params),
    errorCode: params.code,
  };
}

function logRequest(fields: logger.Fields & { statusCode: number }): void {
  if (fields.statusCode >= 500) {
    logger.error('http request', fields);
    return;
  }

  if (fields.statusCode >= 400) {
    logger.warn('http request', fields);
    return;
  }

  logger.info('http request', fields);
}

function resolveAccountId(event: Event): string | undefined {
  if (!('authorizer' in event.requestContext)) {
    return undefined;
  }

  return event.requestContext.authorizer?.jwt?.claims?.['internalId'] as string | undefined;
}

function resolveClientIp(event: Event): string {
  return event.requestContext.http.sourceIp;
}

function resolveRateLimitKey(
  rule: RateLimitRule,
  request: Controller.Request<'private' | 'public'>,
  event: Event,
): string | undefined {
  switch (rule.scope) {
    case 'ip':
      return `${event.routeKey}#${resolveClientIp(event)}`;
    case 'account':
      return 'accountId' in request ? `${event.routeKey}#${request.accountId}` : undefined;
    case 'email': {
      const email = request.body?.[rule.field ?? 'email'];
      return typeof email === 'string' ? `${event.routeKey}#email#${email.trim().toLowerCase()}` : undefined;
    }
    default:
      return undefined;
  }

}
