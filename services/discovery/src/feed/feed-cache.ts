import type { Redis } from 'ioredis';
import { z } from 'zod';

/** The viewer's own condition filter, as the feed reports it (M3.4). */
export type FilterState = 'off' | 'on' | 'too_few_nearby' | 'needs_your_sharing' | 'unavailable';

/** A built feed: account ids in order with the private flag, and a generation id for cursors. */
export interface CachedFeed {
  generation: string;
  items: { id: string; private: boolean }[];
  /** Kept only in memory: Redis holds plain feeds, whose state is always `off`. */
  filter?: FilterState;
}

/** Approved (M3.2): a feed is kept 15 minutes, then rebuilt. */
export const FEED_TTL_SECONDS = 15 * 60;

export interface FeedCache {
  get(viewerId: string): Promise<CachedFeed | undefined>;
  set(viewerId: string, feed: CachedFeed, ttlSeconds?: number): Promise<void>;
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
    // Never a filtered feed or its state: those imply health and stay in memory (M3.4, approved).
    if (feed.filter !== undefined && feed.filter !== 'off') throw new Error('not for Redis');
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
    // A stand-in for Redis, so it refuses what Redis must never hold.
    if (feed.filter !== undefined && feed.filter !== 'off') throw new Error('not for Redis');
    this.feeds.set(viewerId, structuredClone(feed));
    return Promise.resolve();
  }
}

/**
 * Feeds that a condition filter shaped (M3.4, approved): held in this process only, never written
 * to Redis or disk, gone on restart. Bounded, so memory cannot grow without limit: the oldest go
 * first.
 */
export class MemoryFeedCache implements FeedCache {
  readonly #feeds = new Map<string, { feed: CachedFeed; expiresAt: number }>();
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: { maxFeeds?: number; now?: () => number } = {}) {
    this.#max = options.maxFeeds ?? 20_000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#feeds.size;
  }

  get(viewerId: string): Promise<CachedFeed | undefined> {
    const entry = this.#feeds.get(viewerId);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAt <= this.#now()) {
      this.#feeds.delete(viewerId);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(structuredClone(entry.feed));
  }

  set(viewerId: string, feed: CachedFeed, ttlSeconds = FEED_TTL_SECONDS): Promise<void> {
    this.#feeds.delete(viewerId);
    this.#feeds.set(viewerId, {
      feed: structuredClone(feed),
      expiresAt: this.#now() + ttlSeconds * 1000,
    });
    while (this.#feeds.size > this.#max) {
      const oldest = this.#feeds.keys().next();
      if (oldest.done === true) break;
      this.#feeds.delete(oldest.value);
    }
    return Promise.resolve();
  }

  delete(viewerId: string): void {
    this.#feeds.delete(viewerId);
  }
}
