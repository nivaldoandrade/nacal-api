
export type RateLimitRule = {
  scope: 'ip' | 'account' | 'email' | 'token';
  field?: string;
  limit: number;
  windowSeconds: number;
}

const RATE_LIMIT_METADATA_KEY = 'custom:rateLimit';

export function RateLimit(rule: RateLimitRule): ClassDecorator {
  return (target) => {
    const rules = Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, target) as RateLimitRule[] | undefined;

    Reflect.defineMetadata(
      RATE_LIMIT_METADATA_KEY,
      [...(rules ?? []), rule],
      target,
    );
  };
}

export function getRateLimitRules(target: object): RateLimitRule[] {
  return Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, target.constructor) ?? [];
}
