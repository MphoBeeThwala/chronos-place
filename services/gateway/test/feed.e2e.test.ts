import { FeedFilter, FeedOutcome } from '@chronos/contracts/discovery';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeDiscovery } from './support/fake-matching.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const identity = new FakeIdentity();
const profile = new FakeProfile();
const discovery = new FakeDiscovery();
let gateway: TestGateway;
let n = 0;
const member = () => {
  n += 1;
  const id = `ffffffff-ffff-4fff-8fff-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  return id;
};
const as = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });
const FEED = `query($first: Int, $after: String) { feed(first: $first, after: $after) { status conditionFilter edges { cursor node { id displayName distanceKm } } pageInfo { endCursor hasNextPage } } }`;
/** Profiles the fake profile service shows. */
const shown = new Set<string>();

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start(), discovery.start()]);
  gateway = await startGateway(identity, { profile, discovery });
  profile.handlers.set('getCatalogue', () => ({ prompts: [] }));
  profile.handlers.set('getPublicProfiles', (r) => ({
    profiles: (r['accountIds'] as string[])
      .filter((id) => shown.has(id))
      .map((accountId) => ({
        accountId,
        displayName: 'Synthetic member',
        age: 30,
        bio: '',
        areaLabel: '',
        distanceKm: 5,
        prompts: [],
        verified: false,
        photos: [],
      })),
  }));
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop(), discovery.stop()]);
});

describe('feed (M3.2)', () => {
  it('needs a session', async () => {
    expect(codes(await gql(gateway.url, FEED))).toEqual(['UNAUTHENTICATED']);
  });

  it('returns the cards in discovery order, leaving out any profile not shown', async () => {
    const [me, a, gone, b] = [member(), member(), member(), member()];
    shown.add(a).add(b);
    discovery.handlers.set('getFeed', () => ({
      outcome: FeedOutcome.FEED_OUTCOME_OK,
      accountIds: [b, gone, a],
      nextPageToken: 'next',
      filter: FeedFilter.FEED_FILTER_ON,
    }));
    const response = await gql(gateway.url, FEED, {
      ...(await as(me)),
      variables: { first: 3, after: 'prev' },
    });
    expect(response.body.data).toEqual({
      feed: {
        status: 'OK',
        conditionFilter: 'ON',
        edges: [
          { cursor: 'next', node: { id: b, displayName: 'Synthetic member', distanceKm: 5 } },
          { cursor: 'next', node: { id: a, displayName: 'Synthetic member', distanceKm: 5 } },
        ],
        pageInfo: { endCursor: 'next', hasNextPage: true },
      },
    });
    expect(discovery.calls.at(-1)?.request).toEqual({
      viewerAccountId: me,
      pageSize: 3,
      pageToken: 'prev',
    });
  });

  it('says why the feed is empty, so the app can ask for an area', async () => {
    for (const [outcome, expected] of [
      [FeedOutcome.FEED_OUTCOME_NO_LOCATION, 'LOCATION_REQUIRED'],
      [FeedOutcome.FEED_OUTCOME_NO_PROFILE, 'PROFILE_REQUIRED'],
    ] as const) {
      discovery.handlers.set('getFeed', () => ({ outcome, accountIds: [], nextPageToken: '' }));
      const response = await gql(gateway.url, FEED, await as(member()));
      expect(response.body.data).toEqual({
        feed: {
          status: expected,
          conditionFilter: 'UNAVAILABLE',
          edges: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      });
    }
  });

  it('caps a page at 50, and reports discovery being down without detail', async () => {
    const big = await gql(gateway.url, FEED, { ...(await as(member())), variables: { first: 51 } });
    expect(codes(big)).toEqual(['BAD_USER_INPUT']);
    discovery.handlers.set('getFeed', () => {
      throw new GrpcFailure(status.UNAVAILABLE, 'Discovery is unavailable. Try again.');
    });
    const down = await gql(gateway.url, FEED, await as(member()));
    expect(codes(down)).toEqual(['UNAVAILABLE']);
  });

  it('reports each condition filter state, and is never cached', async () => {
    for (const [filter, expected] of [
      [FeedFilter.FEED_FILTER_OFF, 'OFF'],
      [FeedFilter.FEED_FILTER_TOO_FEW_NEARBY, 'TOO_FEW_NEARBY'],
      [FeedFilter.FEED_FILTER_NEEDS_YOUR_SHARING, 'NEEDS_YOUR_SHARING'],
      [FeedFilter.FEED_FILTER_UNAVAILABLE, 'UNAVAILABLE'],
    ] as const) {
      discovery.handlers.set('getFeed', () => ({
        outcome: FeedOutcome.FEED_OUTCOME_OK,
        accountIds: [],
        nextPageToken: '',
        filter,
      }));
      const response = await gql(gateway.url, FEED, await as(member()));
      expect(response.body.data?.['feed']).toMatchObject({ conditionFilter: expected });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
