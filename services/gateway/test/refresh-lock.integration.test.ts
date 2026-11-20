import { loadConfig } from '@chronos/config';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lockKey, RedisRefreshLock } from '../src/auth/refresh-lock.js';

let redis: Redis;
let container: StartedRedisContainer | undefined;

beforeAll(async () => {
  const { TEST_REDIS_URL: url } = loadConfig(z.object({ TEST_REDIS_URL: z.string().optional() }));
  if (url !== undefined && url !== '') redis = new Redis(url);
  else {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl());
  }
});

afterAll(async () => {
  await redis.quit();
  await container?.stop();
});

const token = () => `token-${String(Math.random())}`;

describe('RedisRefreshLock', () => {
  it('lets exactly one of many concurrent refreshes in', async () => {
    const lock = new RedisRefreshLock(redis);
    const t = token();
    const leases = await Promise.all(Array.from({ length: 20 }, () => lock.acquire(t, 5000)));
    expect(leases.filter((l) => l !== undefined)).toHaveLength(1);
  });

  it('frees the lock on release, but only for the lease that holds it', async () => {
    const lock = new RedisRefreshLock(redis);
    const t = token();
    const lease = await lock.acquire(t, 5000);
    await lock.release(t, 'someone-else');
    expect(await lock.acquire(t, 5000)).toBeUndefined();
    if (lease) await lock.release(t, lease);
    expect(await lock.acquire(t, 5000)).toBeDefined();
  });

  it('expires a lease that was never released', async () => {
    const lock = new RedisRefreshLock(redis);
    const t = token();
    await lock.acquire(t, 100);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await lock.acquire(t, 100)).toBeDefined();
  });

  it('never stores the refresh token itself', async () => {
    const lock = new RedisRefreshLock(redis);
    const t = token();
    await lock.acquire(t, 5000);
    expect(lockKey(t)).not.toContain(t);
    expect(await redis.keys(`*${t}*`)).toEqual([]);
  });
});
