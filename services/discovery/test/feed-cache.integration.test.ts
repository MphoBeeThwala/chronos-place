import { loadConfig } from '@chronos/config';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEED_TTL_SECONDS, RedisFeedCache } from '../src/feed/feed-cache.js';
import { member, VIEWER } from './support/fakes.js';

const { TEST_REDIS_URL: url } = loadConfig(z.object({ TEST_REDIS_URL: z.string().optional() }));
let redis: Redis;

describe.skipIf(url === undefined)('Redis feed cache', () => {
  beforeAll(() => {
    redis = new Redis(url as string);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('keeps ids and flags only, for 15 minutes', async () => {
    const cache = new RedisFeedCache(redis);
    const [a, b] = [member(), member()];
    await cache.set(VIEWER, {
      generation: 'g1',
      items: [
        { id: a, private: false },
        { id: b, private: true },
      ],
    });
    expect(await cache.get(VIEWER)).toEqual({
      generation: 'g1',
      items: [
        { id: a, private: false },
        { id: b, private: true },
      ],
    });
    const key = `discovery:feed:v1:${VIEWER}`;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(FEED_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(FEED_TTL_SECONDS);
    expect(JSON.parse((await redis.get(key)) ?? '{}')).toEqual({
      g: 'g1',
      i: [
        [a, 0],
        [b, 1],
      ],
    });
  });

  it('treats an unreadable value as no feed', async () => {
    const cache = new RedisFeedCache(redis);
    const viewer = member();
    await redis.set(`discovery:feed:v1:${viewer}`, JSON.stringify({ g: 1 }), 'EX', 60);
    expect(await cache.get(viewer)).toBeUndefined();
  });
});
