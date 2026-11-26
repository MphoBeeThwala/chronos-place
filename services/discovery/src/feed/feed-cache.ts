import type { Redis } from 'ioredis';
import { z } from 'zod';

/** A built feed: account ids in order with the private flag, and a generation id for cursors. */
export interface CachedFeed {
  generation: string;
  items: { id: string; private: boolean }[];
}

/** Approved (M3.2): a feed is kept 15 minutes, then rebuilt. */
export const FEED_TTL_SECONDS = 15 * 60;

export interface FeedCache {
  get(viewerId: string): Promise<CachedFeed | undefined>;
  set(viewerId: string, feed: CachedFeed): Promise<void>;
}

const stored = z.object({
  g: z.string(),
  i: z.array(z.tuple([z.uuid(), z.union([z.literal(0), z.literal(1)])])),
});

/** Keys hold the viewer's account id only; values hold account ids only (no health, rule 3). */
const key = (viewerId: string) => `discovery:feed:v1:${viewerId}`;

export class RedisFeedCache implements FeedCache {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(viewerId: string): Promise<CachedFeed | undefined> {
    const raw = await this.#redis.get(key(viewerId));
    if (raw === null) return undefined;
    const parsed = stored.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return {
      generation: parsed.data.g,
      items: parsed.data.i.map(([id, p]) => ({ id, private: p === 1 })),
    };
  }

  async set(viewerId: string, feed: CachedFeed): Promise<void> {
    const value = JSON.stringify({
      g: feed.generation,
      i: feed.items.map((item) => [item.id, item.private ? 1 : 0]),
    });
    await this.#redis.set(key(viewerId), value, 'EX', FEED_TTL_SECONDS);
  }
}

export class InMemoryFeedCache implements FeedCache {
  readonly feeds = new Map<string, CachedFeed>();

  get(viewerId: string): Promise<CachedFeed | undefined> {
    return Promise.resolve(this.feeds.get(viewerId));
  }

  set(viewerId: string, feed: CachedFeed): Promise<void> {
    this.feeds.set(viewerId, structuredClone(feed));
    return Promise.resolve();
  }
}
