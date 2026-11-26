import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeMatching } from './support/fake-matching.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const identity = new FakeIdentity();
const profile = new FakeProfile();
const matching = new FakeMatching();
let gateway: TestGateway;
let n = 0;
const member = () => {
  n += 1;
  const id = `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  return id;
};
const as = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });
const called = (method: string) => matching.calls.filter((c) => c.method === method);
const MATCH = 'eeeeeeee-eeee-4eee-8eee-000000000001';
// The fakes encode timestamps from Date objects, like the services.
const AT = new Date(1764000000 * 1000);
const AT_ISO = AT.toISOString();

/** Public profiles the fake profile service shows; everyone else is hidden (blocked, paused…). */
const visible = new Set<string>();
const wire = (accountId: string) => ({
  accountId,
  displayName: 'Synthetic member',
  age: 30,
  bio: '',
  areaLabel: 'Durban',
  prompts: [{ promptId: 'laugh', answer: 'A' }],
  verified: false,
  photos: [],
});

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start(), matching.start()]);
  gateway = await startGateway(identity, { profile, matching });
  profile.handlers.set('getCatalogue', () => ({ prompts: [{ id: 'laugh', question: 'Q?' }] }));
  profile.handlers.set('getPublicProfiles', (r) => ({
    profiles: (r['accountIds'] as string[]).filter((id) => visible.has(id)).map(wire),
  }));
});

beforeEach(() => {
  visible.clear();
  matching.calls.length = 0;
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop(), matching.stop()]);
});

describe('like and pass', () => {
  const LIKE = `mutation($a: ID!) { like(accountId: $a) { matched match { id matchedAt profile { id displayName prompts { question } } } } }`;

  it('needs a session', async () => {
    expect(codes(await gql(gateway.url, LIKE, { variables: { a: member() } }))).toEqual([
      'UNAUTHENTICATED',
    ]);
  });

  it('returns the match and its profile on a like back', async () => {
    const [me, them] = [member(), member()];
    visible.add(them);
    matching.handlers.set('like', () => ({ matched: true, matchId: MATCH }));
    matching.handlers.set('getMatch', () => ({
      match: { matchId: MATCH, otherAccountId: them, createdAt: AT, cursor: '' },
    }));
    const response = await gql(gateway.url, LIKE, { ...(await as(me)), variables: { a: them } });
    expect(response.body.data).toEqual({
      like: {
        matched: true,
        match: {
          id: MATCH,
          matchedAt: AT_ISO,
          profile: { id: them, displayName: 'Synthetic member', prompts: [{ question: 'Q?' }] },
        },
      },
    });
    expect(called('like').at(-1)?.request).toEqual({ fromAccountId: me, toAccountId: them });
  });

  it('answers like no match, without telling matching, for someone the member cannot see', async () => {
    // Blocked either way, paused, gone or never existed: indistinguishable (M3.1 AC).
    const response = await gql(gateway.url, LIKE, {
      ...(await as(member())),
      variables: { a: member() },
    });
    expect(response.body.data).toEqual({ like: { matched: false, match: null } });
    expect(called('like')).toEqual([]);
  });

  it('refuses acting on yourself and malformed ids', async () => {
    const me = member();
    for (const a of [me, 'not-an-id']) {
      const response = await gql(gateway.url, LIKE, { ...(await as(me)), variables: { a } });
      expect(codes(response)).toEqual(['BAD_USER_INPUT']);
    }
    expect(matching.calls).toEqual([]);
  });

  it('passes', async () => {
    const [me, them] = [member(), member()];
    matching.handlers.set('pass', () => ({}));
    const response = await gql(gateway.url, `mutation($a: ID!) { pass(accountId: $a) }`, {
      ...(await as(me)),
      variables: { a: them },
    });
    expect(response.body.data).toEqual({ pass: true });
    expect(called('pass').at(-1)?.request).toEqual({ fromAccountId: me, toAccountId: them });
  });
});

describe('matches', () => {
  const MATCHES = `query($first: Int, $after: String) { matches(first: $first, after: $after) { edges { cursor node { id matchedAt profile { id } } } pageInfo { endCursor hasNextPage } } }`;

  it('lists matches with profiles, leaving out any whose profile is not shown', async () => {
    const [me, shown, hidden] = [member(), member(), member()];
    visible.add(shown);
    matching.handlers.set('listMatches', () => ({
      matches: [
        { matchId: MATCH, otherAccountId: shown, createdAt: AT, cursor: 'c1' },
        { matchId: MATCH.replace('1', '2'), otherAccountId: hidden, createdAt: AT, cursor: 'c2' },
      ],
      nextPageToken: 'c2',
    }));
    const response = await gql(gateway.url, MATCHES, {
      ...(await as(me)),
      variables: { first: 2, after: 'c0' },
    });
    expect(response.body.data).toEqual({
      matches: {
        edges: [{ cursor: 'c1', node: { id: MATCH, matchedAt: AT_ISO, profile: { id: shown } } }],
        pageInfo: { endCursor: 'c2', hasNextPage: true },
      },
    });
    expect(called('listMatches').at(-1)?.request).toEqual({
      accountId: me,
      pageSize: 2,
      pageToken: 'c0',
    });
  });

  it('caps a page at 50', async () => {
    const response = await gql(gateway.url, MATCHES, {
      ...(await as(member())),
      variables: { first: 51 },
    });
    expect(codes(response)).toEqual(['BAD_USER_INPUT']);
  });

  it('unmatches, and says plainly when the match is not the member’s', async () => {
    const me = member();
    const UNMATCH = `mutation($m: ID!) { unmatch(matchId: $m) }`;
    matching.handlers.set('unmatch', () => ({}));
    const ok = await gql(gateway.url, UNMATCH, { ...(await as(me)), variables: { m: MATCH } });
    expect(ok.body.data).toEqual({ unmatch: true });
    expect(called('unmatch').at(-1)?.request).toEqual({ accountId: me, matchId: MATCH });

    matching.handlers.set('unmatch', () => {
      throw new GrpcFailure(status.NOT_FOUND, 'That match was not found.');
    });
    const missing = await gql(gateway.url, UNMATCH, { ...(await as(me)), variables: { m: MATCH } });
    expect(codes(missing)).toEqual(['NOT_FOUND']);
  });
});

describe('blocks', () => {
  it('blocks and unblocks, always answering true', async () => {
    const [me, them] = [member(), member()];
    matching.handlers.set('block', () => ({}));
    matching.handlers.set('unblock', () => ({}));
    for (const field of ['block', 'unblock'] as const) {
      const response = await gql(gateway.url, `mutation($a: ID!) { ${field}(accountId: $a) }`, {
        ...(await as(me)),
        variables: { a: them },
      });
      expect(response.body.data).toEqual({ [field]: true });
      expect(called(field).at(-1)?.request).toEqual({
        blockerAccountId: me,
        blockedAccountId: them,
      });
    }
  });

  it('lists the members the member blocked', async () => {
    const [me, them] = [member(), member()];
    matching.handlers.set('listBlocked', () => ({
      blocked: [{ accountId: them, blockedAt: AT }],
    }));
    const response = await gql(gateway.url, `{ blockedMembers { accountId blockedAt } }`, {
      ...(await as(me)),
    });
    expect(response.body.data).toEqual({
      blockedMembers: [{ accountId: them, blockedAt: AT_ISO }],
    });
    expect(called('listBlocked').at(-1)?.request).toEqual({ accountId: me });
  });

  it('says the service is unavailable, and nothing more, when matching is down', async () => {
    matching.handlers.set('block', () => {
      throw new GrpcFailure(status.UNAVAILABLE, 'connect ECONNREFUSED 10.0.0.9:50056');
    });
    const response = await gql(gateway.url, `mutation($a: ID!) { block(accountId: $a) }`, {
      ...(await as(member())),
      variables: { a: member() },
    });
    expect(response.body.errors?.map((e) => [e.message, e.extensions?.code])).toEqual([
      ['Service unavailable. Try again.', 'UNAVAILABLE'],
    ]);
  });
});
