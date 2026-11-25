import { createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Redis } from 'ioredis';

/** Approved limits (ADR-0021, decision a). Changing them is a product decision. */
export const RATE_LIMITS = {
  /** Shared IPs (mobile carriers, offices) are why this is not lower. */
  perIp: { limit: 300, windowSeconds: 60 },
  perAccount: { limit: 600, windowSeconds: 60 },
} as const;

export interface RateLimitStore {
  /** Counts one request in a fixed window and returns the count so far and the seconds left. */
  hit(key: string, windowSeconds: number): Promise<{ count: number; resetSeconds: number }>;
}

// INCR and EXPIRE together, so a window never loses its expiry.
const HIT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async hit(key: string, windowSeconds: number): Promise<{ count: number; resetSeconds: number }> {
    const [count, resetSeconds] = (await this.#redis.eval(
      HIT,
      1,
      `gateway:rl:v1:${key}`,
      String(windowSeconds),
    )) as [number, number];
    return { count, resetSeconds };
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, { count: number; until: number }>();

  hit(key: string, windowSeconds: number): Promise<{ count: number; resetSeconds: number }> {
    const now = Date.now();
    let window = this.#windows.get(key);
    if (!window || window.until <= now) {
      window = { count: 0, until: now + windowSeconds * 1000 };
      this.#windows.set(key, window);
    }
    window.count += 1;
    return Promise.resolve({
      count: window.count,
      resetSeconds: Math.ceil((window.until - now) / 1000),
    });
  }
}

/**
 * Per-IP and per-account request limits, checked before any work is done. IPs are personal data,
 * so their keys are keyed hashes, never the address (CLAUDE.md rule 3: no personal data in cache keys).
 */
export class RateLimiter {
  readonly #store: RateLimitStore;
  readonly #key: Buffer;

  constructor(store: RateLimitStore, hashKey: Uint8Array) {
    if (hashKey.length < 32) throw new Error('rate limit hash key must be at least 32 bytes');
    this.#store = store;
    this.#key = Buffer.from(hashKey);
  }

  async check(ip: string, accountId: string | undefined): Promise<void> {
    const ipKey = createHmac('sha256', this.#key).update(`ip\0${ip}`).digest('hex');
    const checks: [string, { limit: number; windowSeconds: number }][] = [
      [`ip:${ipKey}`, RATE_LIMITS.perIp],
    ];
    if (accountId !== undefined) checks.push([`account:${accountId}`, RATE_LIMITS.perAccount]);
    let wait = 0;
    for (const [key, { limit, windowSeconds }] of checks) {
      const { count, resetSeconds } = await this.#store.hit(key, windowSeconds);
      if (count > limit) wait = Math.max(wait, resetSeconds);
    }
    if (wait > 0) {
      throw new GraphQLError('Too many requests. Try again shortly.', {
        extensions: { code: 'RATE_LIMITED', retryAfterSeconds: wait, http: { status: 429 } },
      });
    }
  }
}
