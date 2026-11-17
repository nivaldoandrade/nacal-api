import { RateLimitExceeded } from '@application/errors/http/RateLimitExceeded';
import { RateLimitRepository } from '@infra/databases/dynamodb/RateLimitRepository';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class RateLimitService {

  constructor(
    private readonly rateLimitRepository: RateLimitRepository,
  ) { }

  async check({
    scope,
    key,
    limit,
    windowSeconds,
  }: RateLimitService.CheckParams): Promise<void> {
    const count = await this.rateLimitRepository.increment({
      scope,
      key,
      windowSeconds,
      limit,
    });

    if (count === null || count > limit) {
      throw new RateLimitExceeded(`Rate limit exceeded for ${scope} "${key}"`);
    }
  }
}

export namespace RateLimitService {
  export type CheckParams = {
    scope: RateLimitRepository.RateLimitScope;
    key: string;
    limit: number;
    windowSeconds: number;
  }
}
