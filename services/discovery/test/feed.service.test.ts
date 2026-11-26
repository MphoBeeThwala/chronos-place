import { createLogger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { InMemoryFeedCache } from '../src/feed/feed-cache.js';
import { FEED_SIZE, FeedService, MAX_CANDIDATE_PAGES } from '../src/feed/feed.service.js';
import { FakeFilter, FakeSource, member, NEUTRAL, VIEWER } from './support/fakes.js';

function setup() {
  const source = new FakeSource();
  const filter = new FakeFilter();
  const cache = new InMemoryFeedCache();
  const lines: string[] = [];
  const service = new FeedService({
    source,
    filter,
    cache,
    logger: createLogger({
      service: 'discovery-test',
      level: 'trace',
      destination: { write: (l: string) => lines.push(l) },
    }),
  });
  return { source, filter, cache, service, lines };
}
const ids = (count: number) => Array.from({ length: count }, () => member());
const as = (list: string[]) => list.map((accountId) => ({ accountId }));

describe('the feed (M3.2, ADR-0026)', () => {
  it('pages through the candidates in order, filtered by matching', async () => {
    const { source, filter, service } = setup();
    const all = ids(5);
    source.set(as(all));
    filter.hidden.add(all[1] as string);
    const first = await service.page(VIEWER, 2, '');
    expect(first).toMatchObject({ outcome: 'ok', accountIds: [all[0], all[2]] });
    const second = await service.page(VIEWER, 2, first.nextPageToken);
    expect(second.accountIds).toEqual([all[3], all[4]]);
    expect(second.nextPageToken).toBe('');
  });

  it('passes on "no profile" and "no location" and keeps nothing', async () => {
    for (const outcome of ['no_profile', 'no_location'] as const) {
      const { source, cache, service } = setup();
      source.pages = [{ outcome, candidates: [], nextPageToken: '' }];
      expect(await service.page(VIEWER, 10, '')).toEqual({
        outcome,
        accountIds: [],
        nextPageToken: '',
      });
      expect(cache.feeds.size).toBe(0);
    }
  });

  it('keeps the built feed, and checks every page again so a new block applies at once', async () => {
    const { source, filter, service } = setup();
    const all = ids(4);
    source.set(as(all));
    await service.page(VIEWER, 2, '');
    filter.hidden.add(all[0] as string);
    expect((await service.page(VIEWER, 2, '')).accountIds).toEqual([all[1]]);
    expect(source.calls).toBe(1);
  });

  it('shows a private member only if they liked the viewer', async () => {
    const { source, filter, service } = setup();
    const [shy, liker, plain] = ids(3) as [string, string, string];
    source.set([
      { accountId: shy, privateMode: true },
      { accountId: liker, privateMode: true },
      { accountId: plain },
    ]);
    filter.likedViewer.add(liker);
    expect((await service.page(VIEWER, 10, '')).accountIds).toEqual([liker, plain]);
    // The flag is kept with the feed, so the page check applies the same rule.
    expect(filter.requests.at(-1)?.privateIds).toEqual([liker]);
  });

  it('reads further candidate pages when nearby members were all seen, up to a limit', async () => {
    const { source, filter, service } = setup();
    const pages = Array.from({ length: MAX_CANDIDATE_PAGES + 1 }, () => ids(3));
    source.set(...pages.map(as));
    for (const id of pages.slice(0, 2).flat()) filter.hidden.add(id);
    const page = await service.page(VIEWER, 50, '');
    expect(page.accountIds).toEqual(pages.slice(2, MAX_CANDIDATE_PAGES).flat());
    expect(source.calls).toBe(MAX_CANDIDATE_PAGES);
  });

  it(`stops building at ${String(FEED_SIZE)} members`, async () => {
    const { source, service, cache } = setup();
    source.set(as(ids(FEED_SIZE + 10)));
    await service.page(VIEWER, 1, '');
    expect([...cache.feeds.values()][0]?.items).toHaveLength(FEED_SIZE);
  });

  it('starts from the top when the cursor belongs to an older feed', async () => {
    const { source, service, cache } = setup();
    const all = ids(3);
    source.set(as(all));
    const first = await service.page(VIEWER, 1, '');
    cache.feeds.clear();
    expect((await service.page(VIEWER, 1, first.nextPageToken)).accountIds).toEqual([all[0]]);
  });

  it('caps a page at 50 and rejects a bad token', async () => {
    const { source, filter, service } = setup();
    source.set(as(ids(60)));
    await service.page(VIEWER, 500, '');
    expect(filter.requests.at(-1)?.ids).toHaveLength(50);
    await expect(service.page(VIEWER, 10, 'not-a-token')).rejects.toBeInstanceOf(DomainError);
  });

  it('shows nothing when profile or matching cannot answer (fail closed)', async () => {
    for (const broken of ['source', 'filter'] as const) {
      const { source, filter, service } = setup();
      source.set(as(ids(2)));
      if (broken === 'source') source.down = true;
      else filter.down = true;
      await expect(service.page(VIEWER, 10, '')).rejects.toMatchObject({ code: 'unavailable' });
    }
  });

  it('logs counts only, never the members in the feed', async () => {
    const { source, service, lines } = setup();
    const all = ids(3);
    source.set(as(all));
    await service.page(VIEWER, 10, '');
    const log = lines.join('\n');
    expect(log).toContain('feed built');
    for (const id of all) expect(log).not.toContain(id);
  });
});

describe('ranking the feed (M3.3)', () => {
  it('orders the feed by score, and keeps only the order', async () => {
    const { source, service, cache } = setup();
    const [near, active] = [member(), member()];
    source.set([
      { accountId: near, features: { ...NEUTRAL, closeness: 100, activity: 0 } },
      { accountId: active, features: { ...NEUTRAL, closeness: 60, activity: 100 } },
    ]);
    expect((await service.page(VIEWER, 10, '')).accountIds).toEqual([active, near]);
    expect(Object.keys([...cache.feeds.values()][0]?.items[0] ?? {}).sort()).toEqual([
      'id',
      'private',
    ]);
  });

  it('ranks everyone on the pages read, wider than the feed, and reads no page it does not need', async () => {
    const { source, service, cache } = setup();
    // One page of 450: the best are the furthest away, past the 200 that are kept.
    const page = Array.from({ length: 450 }, (_, i) => ({
      accountId: member(),
      features: { ...NEUTRAL, activity: i >= 350 ? 100 : 0 },
    }));
    source.set(page, [{ accountId: member() }]);
    await service.page(VIEWER, 1, '');
    const kept = [...cache.feeds.values()][0]?.items.map((i) => i.id) ?? [];
    expect(kept).toHaveLength(FEED_SIZE);
    expect(kept.slice(0, 100)).toEqual(page.slice(350).map((c) => c.accountId));
    expect(source.calls).toBe(1);
  });
});
