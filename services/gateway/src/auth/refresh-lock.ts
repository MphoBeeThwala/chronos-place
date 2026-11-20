import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * One refresh at a time per refresh token, across every gateway replica (ADR-0018: a second,
 * racing exchange counts as reuse and ends the session). Keys are hashes of the token.
 */
export interface RefreshLock {
  /** A lease token if acquired, or undefined if another refresh holds the lock. */
  acquire(refreshToken: string, ttlMs: number): Promise<string | undefined>;
  release(refreshToken: string, lease: string): Promise<void>;
}

export const lockKey = (refreshToken: string): string =>
  `gateway:refresh:v1:${createHash('sha256').update(refreshToken).digest('hex')}`;

// Deletes the key only if this lease still holds it, so an expired lease cannot free a newer one.
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class RedisRefreshLock implements RefreshLock {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async acquire(refreshToken: string, ttlMs: number): Promise<string | undefined> {
    const lease = randomUUID();
    const ok = await this.#redis.set(lockKey(refreshToken), lease, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? lease : undefined;
  }

  async release(refreshToken: string, lease: string): Promise<void> {
    await this.#redis.eval(RELEASE, 1, lockKey(refreshToken), lease);
  }
}

/** Single-process lock for tests and local runs without Redis. */
export class InMemoryRefreshLock implements RefreshLock {
  readonly #held = new Map<string, { lease: string; until: number }>();

  acquire(refreshToken: string, ttlMs: number): Promise<string | undefined> {
    const key = lockKey(refreshToken);
    const held = this.#held.get(key);
    if (held && held.until > Date.now()) return Promise.resolve(undefined);
    const lease = randomUUID();
    this.#held.set(key, { lease, until: Date.now() + ttlMs });
    return Promise.resolve(lease);
  }

  release(refreshToken: string, lease: string): Promise<void> {
    const key = lockKey(refreshToken);
    if (this.#held.get(key)?.lease === lease) this.#held.delete(key);
    return Promise.resolve();
  }
}
