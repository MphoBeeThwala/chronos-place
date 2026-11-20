import type { Redis } from 'ioredis';

export interface HitResult {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

/**
 * Fixed-window counters and locks. Keys are built from keyed hashes, never from a phone number,
 * IP or device id in the clear (CLAUDE.md rule 3: no personal data in cache keys).
 */
export interface RateLimitStore {
  /** Counts one hit in the window and returns the new count. */
  hit(key: string, windowSeconds: number): Promise<HitResult>;
  /** Seconds left on a lock or cooldown, or 0 when none is set. */
  ttl(key: string): Promise<number>;
  /** Sets a lock or cooldown for `seconds`. */
  set(key: string, seconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// INCR and EXPIRE in one step, so a window can never be left without an expiry.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'identity:otp:v1') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async hit(key: string, windowSeconds: number): Promise<HitResult> {
    const [count, ttl] = (await this.#redis.eval(
      HIT_SCRIPT,
      1,
      this.#key(key),
      String(windowSeconds),
    )) as [number, number];
    return { count, resetSeconds: ttl };
  }

  async ttl(key: string): Promise<number> {
    return Math.max(0, await this.#redis.ttl(this.#key(key)));
  }

  async set(key: string, seconds: number): Promise<void> {
    await this.#redis.set(this.#key(key), '1', 'EX', seconds);
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(this.#key(key));
  }

  #key(key: string): string {
    return `${this.#prefix}:${key}`;
  }
}
