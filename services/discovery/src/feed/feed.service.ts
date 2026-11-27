import { randomUUID } from 'node:crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { z } from 'zod';
import type { CachedFeed, FeedCache, FilterState } from './feed-cache.js';
import { rank } from './ranking.js';
import {
  type Candidate,
  type CandidateFilter,
  type CandidateSource,
  type ConditionFilter,
  DependencyUnavailable,
  type Outcome,
} from './sources.js';

/** A built feed holds up to this many members; a new one is built when it expires. */
export const FEED_SIZE = 200;
/** Candidate pages read while building, so a member who has seen everyone nearby still gets some. */
export const MAX_CANDIDATE_PAGES = 4;
/**
 * Ranking (M3.3) chooses among everyone on the candidate pages read, up to 500 a page, which is
 * wider than the feed. Another page is read only while fewer than FEED_SIZE remain: a page costs
 * the most of any step, and a second one would break the 300 ms target (speed test).
 */
export const RANKING_POOL_MAX = MAX_CANDIDATE_PAGES * 500;
export const DEFAULT_PAGE = 20;
export const MAX_PAGE = 50;

const INVALID = 'Invalid request.';
const UNAVAILABLE = 'Discovery is unavailable. Try again.';

export interface FeedPage {
  outcome: Outcome;
  accountIds: string[];
  nextPageToken: string;
  /** For the viewer alone (M3.4): never logged. */
  filter: FilterState;
}

/** A feed whose condition filter could not be applied is tried again soon. */
export const UNAVAILABLE_FILTER_TTL_SECONDS = 60;
/** The vault takes at most this many candidates in one call (spec 4.3). */
export const VAULT_BATCH = 500;

const cursor = z.object({ g: z.string().max(64), o: z.number().int().min(0).max(FEED_SIZE) });
const encode = (c: z.infer<typeof cursor>) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(token: string): z.infer<typeof cursor> | undefined {
  if (token === '') return undefined;
  try {
    return cursor.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch {
    throw new DomainError('invalid_argument', INVALID);
  }
}

export interface FeedServiceDeps {
  source: CandidateSource;
  filter: CandidateFilter;
  /** Plain feeds (filter `off`): Redis. */
  cache: FeedCache;
  /** The Disclosure Service's condition filter (M3.4). */
  conditions: ConditionFilter;
  /** Feeds a condition filter shaped, and their state: this process's memory only (approved). */
  memory: FeedCache;
  logger: Logger;
}

/**
 * The discovery feed (TASKS M3.2, ADR-0026). A feed is built from profile's candidates, filtered by
 * matching and kept for 15 minutes as account ids. Every page is filtered by matching again, so a
 * block or a like made since takes effect at once. If profile or matching cannot answer, nothing is
 * shown: an unfiltered feed could show someone a member blocked.
 */
export class FeedService {
  readonly #d: FeedServiceDeps;

  constructor(deps: FeedServiceDeps) {
    this.#d = deps;
  }

  async page(viewerId: string, pageSize: number, pageToken: string): Promise<FeedPage> {
    const size = pageSize === 0 ? DEFAULT_PAGE : Math.min(Math.max(pageSize, 1), MAX_PAGE);
    const at = decode(pageToken);
    try {
      let feed = (await this.#d.memory.get(viewerId)) ?? (await this.#d.cache.get(viewerId));
      if (!feed) {
        const built = await this.#build(viewerId);
        if (built.outcome !== 'ok')
          return { outcome: built.outcome, accountIds: [], nextPageToken: '', filter: 'off' };
        feed = built.feed;
        await this.#keep(viewerId, feed);
      }
      // A cursor from an older feed starts the new one from the top.
      const offset = at?.g === feed.generation ? at.o : 0;
      const slice = feed.items.slice(offset, offset + size);
      const kept = await this.#d.filter.filter(
        viewerId,
        slice.map((i) => i.id),
        slice.filter((i) => i.private).map((i) => i.id),
      );
      const next = offset + size;
      return {
        outcome: 'ok',
        accountIds: kept,
        nextPageToken: next < feed.items.length ? encode({ g: feed.generation, o: next }) : '',
        filter: feed.filter ?? 'off',
      };
    } catch (error) {
      if (error instanceof DependencyUnavailable) {
        this.#d.logger.warn('feed dependency unavailable');
        throw new DomainError('unavailable', UNAVAILABLE);
      }
      throw error;
    }
  }

  async #build(
    viewerId: string,
  ): Promise<{ outcome: 'ok'; feed: CachedFeed } | { outcome: Exclude<Outcome, 'ok'> }> {
    const pool: Candidate[] = [];
    let token = '';
    let pages = 0;
    do {
      const page = await this.#d.source.page(viewerId, token);
      if (page.outcome !== 'ok') return { outcome: page.outcome };
      const byId = new Map(page.candidates.map((c) => [c.accountId, c]));
      const kept = await this.#d.filter.filter(
        viewerId,
        page.candidates.map((c) => c.accountId),
        page.candidates.filter((c) => c.privateMode).map((c) => c.accountId),
      );
      for (const id of kept) {
        const candidate = byId.get(id);
        if (candidate && pool.length < RANKING_POOL_MAX) pool.push(candidate);
      }
      token = page.nextPageToken;
      pages += 1;
    } while (token !== '' && pool.length < FEED_SIZE && pages < MAX_CANDIDATE_PAGES);
    // Condition filter last (M3.4), so nobody blocked or already seen is ever opened in the vault.
    const { filter, eligible } = await this.#conditionFilter(
      viewerId,
      pool.map((c) => c.accountId),
    );
    const chosen = filter === 'on' ? pool.filter((c) => eligible.has(c.accountId)) : pool;
    // Only the order is kept: the signals are not stored (ADR-0027).
    const items: CachedFeed['items'] = rank(chosen)
      .slice(0, FEED_SIZE)
      .map((c) => ({ id: c.accountId, private: c.privateMode }));
    // No size and no filter state in the log: either could hint at health (rule 3).
    this.#d.logger.info({ accountId: viewerId, pages }, 'feed built');
    return { outcome: 'ok', feed: { generation: randomUUID(), items, filter } };
  }

  /**
   * Asks the vault, at most 500 candidates a call. The approved fallback: whenever the filter
   * cannot narrow the feed (too few nearby, the viewer not sharing, the vault down), the usual
   * feed is shown and the state says why.
   */
  async #conditionFilter(
    viewerId: string,
    ids: readonly string[],
  ): Promise<{ filter: FilterState; eligible: Set<string> }> {
    const eligible = new Set<string>();
    const plain = (filter: FilterState) => ({ filter, eligible });
    try {
      for (let i = 0; i < Math.max(ids.length, 1); i += VAULT_BATCH) {
        const answer = await this.#d.conditions.eligible(viewerId, ids.slice(i, i + VAULT_BATCH));
        if (answer.outcome === 'no_preferences') return plain('off');
        if (answer.outcome === 'viewer_not_sharing') return plain('needs_your_sharing');
        if (answer.outcome === 'ok') for (const id of answer.eligible) eligible.add(id);
      }
    } catch (error) {
      if (!(error instanceof DependencyUnavailable)) throw error;
      this.#d.logger.warn('condition filter unavailable');
      return { filter: 'unavailable', eligible: new Set() };
    }
    return eligible.size > 0 ? plain('on') : plain('too_few_nearby');
  }

  /** Plain feeds go to Redis; anything a condition filter touched stays in memory (approved). */
  async #keep(viewerId: string, feed: CachedFeed): Promise<void> {
    if (feed.filter === undefined || feed.filter === 'off') {
      await this.#d.cache.set(viewerId, feed);
      return;
    }
    await this.#d.memory.set(
      viewerId,
      feed,
      feed.filter === 'unavailable' ? UNAVAILABLE_FILTER_TTL_SECONDS : undefined,
    );
  }
}
