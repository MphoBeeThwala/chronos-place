import { ConditionStatus, GrantScope, Purpose, Visibility } from '@chronos/contracts/disclosure';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/limits/rate-limit.js';
import { FakeDisclosure } from './support/fake-disclosure.js';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeMatching } from './support/fake-matching.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const identity = new FakeIdentity();
const profile = new FakeProfile();
const disclosure = new FakeDisclosure();
const matching = new FakeMatching();
let gateway: TestGateway;
let n = 0;
const member = () => {
  n += 1;
  const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  return id;
};
const as = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });
const lastCall = (method: string) => disclosure.calls.filter((c) => c.method === method).at(-1);

const OWN = {
  profile: {
    profile: {
      conditions: [{ code: 't1d', status: ConditionStatus.CONDITION_STATUS_LIVING_WITH }],
      freeText: '',
      note: 'Synthetic note',
    },
    visibility: Visibility.VISIBILITY_MATCH_ONLY,
    filterOptIn: true,
    version: 3,
  },
};
const MY_HEALTH = `{ myHealthProfile { conditions { code status } freeText note visibility filterOptIn version } }`;

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start(), disclosure.start(), matching.start()]);
  gateway = await startGateway(identity, { profile, disclosure, matching });
  disclosure.handlers.set('getOwnHealthProfile', () => OWN);
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop(), disclosure.stop(), matching.stop()]);
});

describe('own health profile', () => {
  it('needs a session', async () => {
    expect(codes(await gql(gateway.url, MY_HEALTH))).toEqual(['UNAUTHENTICATED']);
  });

  it('returns it with Cache-Control: no-store (M2.8 AC)', async () => {
    const id = member();
    const response = await gql(gateway.url, MY_HEALTH, await as(id));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body.data?.['myHealthProfile']).toEqual({
      conditions: [{ code: 't1d', status: 'LIVING_WITH' }],
      freeText: null,
      note: 'Synthetic note',
      visibility: 'MATCH_ONLY',
      filterOptIn: true,
      version: 3,
    });
    expect(lastCall('getOwnHealthProfile')?.request).toEqual({ accountId: id });
  });

  it('is null when there is none', async () => {
    disclosure.handlers.set('getOwnHealthProfile', () => ({}));
    try {
      const response = await gql(gateway.url, MY_HEALTH, await as(member()));
      expect(response.body.data).toEqual({ myHealthProfile: null });
    } finally {
      disclosure.handlers.set('getOwnHealthProfile', () => OWN);
    }
  });

  it('saves with the expected version and returns the saved profile', async () => {
    const id = member();
    disclosure.handlers.set('upsertHealthProfile', () => ({ version: 4 }));
    const response = await gql(
      gateway.url,
      `mutation($input: HealthProfileInput!) { upsertHealthProfile(input: $input) { version } }`,
      {
        ...(await as(id)),
        variables: {
          input: {
            conditions: [{ code: 'other', status: 'SURVIVOR' }],
            freeText: 'Synthetic words',
            expectedVersion: 3,
          },
        },
      },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body.errors).toBeUndefined();
    expect(lastCall('upsertHealthProfile')?.request).toEqual({
      accountId: id,
      expectedVersion: 3,
      profile: {
        conditions: [{ code: 'other', status: ConditionStatus.CONDITION_STATUS_SURVIVOR }],
        freeText: 'Synthetic words',
        note: '',
      },
    });
  });

  it('reports a save from another device as CONFLICT, and the service messages as they are', async () => {
    const save = `mutation { upsertHealthProfile(input: { conditions: [] }) { version } }`;
    disclosure.handlers.set('upsertHealthProfile', () => {
      throw new GrpcFailure(
        status.ABORTED,
        'Health profile changed elsewhere; reload and try again.',
      );
    });
    const conflict = await gql(gateway.url, save, await as(member()));
    expect(conflict.body.errors?.[0]).toMatchObject({
      message: 'Health profile changed elsewhere; reload and try again.',
      extensions: { code: 'CONFLICT' },
    });
    disclosure.handlers.set('upsertHealthProfile', () => {
      throw new GrpcFailure(status.INVALID_ARGUMENT, 'Invalid health profile.');
    });
    const invalid = await gql(gateway.url, save, await as(member()));
    expect(invalid.body.errors?.[0]).toMatchObject({
      message: 'Invalid health profile.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('settings', () => {
  it('changes visibility and keeps the filter opt-in when it is left out', async () => {
    const id = member();
    disclosure.handlers.set('setVisibility', () => ({}));
    await gql(
      gateway.url,
      `mutation { setHealthVisibility(visibility: PROFILE) { version } }`,
      await as(id),
    );
    expect(lastCall('setVisibility')?.request).toEqual({
      accountId: id,
      visibility: Visibility.VISIBILITY_PROFILE,
      filterOptIn: true,
    });
    await gql(
      gateway.url,
      `mutation { setHealthVisibility(visibility: HIDDEN, filterOptIn: false) { version } }`,
      await as(id),
    );
    expect(lastCall('setVisibility')?.request).toMatchObject({ filterOptIn: false });
  });

  it('stores and reads filters', async () => {
    const id = member();
    disclosure.handlers.set('setFilterPreferences', () => ({}));
    disclosure.handlers.set('getFilterPreferences', () => ({ wantedConditionCodes: ['lupus'] }));
    const set = await gql(
      gateway.url,
      `mutation { setHealthFilters(conditionCodes: ["lupus"]) }`,
      await as(id),
    );
    expect(set.body.data).toEqual({ setHealthFilters: ['lupus'] });
    expect(lastCall('setFilterPreferences')?.request).toEqual({
      accountId: id,
      wantedConditionCodes: ['lupus'],
    });
    const get = await gql(gateway.url, `{ myHealthFilters }`, await as(id));
    expect(get.body.data).toEqual({ myHealthFilters: ['lupus'] });
    expect(get.headers.get('cache-control')).toBe('no-store');
  });

  it('lists the condition list from the vault, cached', async () => {
    disclosure.handlers.set('listConditionTaxonomy', () => ({
      entries: [{ code: 'asthma', labelEn: 'Asthma', active: true }],
    }));
    const query = `{ conditionTaxonomy { code label } }`;
    const first = await gql(gateway.url, query, await as(member()));
    await gql(gateway.url, query, await as(member()));
    expect(first.body.data).toEqual({ conditionTaxonomy: [{ code: 'asthma', label: 'Asthma' }] });
    expect(disclosure.calls.filter((c) => c.method === 'listConditionTaxonomy')).toHaveLength(1);
  });

  it('revokes a share', async () => {
    const id = member();
    const viewer = member();
    disclosure.handlers.set('revokeDisclosure', () => ({ revoked: true }));
    const response = await gql(
      gateway.url,
      `mutation($a: ID!) { revokeHealthShare(accountId: $a) }`,
      {
        ...(await as(id)),
        variables: { a: viewer },
      },
    );
    expect(response.body.data).toEqual({ revokeHealthShare: true });
    expect(lastCall('revokeDisclosure')?.request).toEqual({
      subjectAccountId: id,
      viewerAccountId: viewer,
    });
  });

  describe('sharing with a match (M3.1)', () => {
    const SHARE = `mutation($m: ID!, $s: GrantScope!) { shareHealthCard(matchId: $m, scope: $s) }`;
    const MATCH = 'cccccccc-cccc-4ccc-8ccc-000000000001';

    it('shares with whoever the active match is with', async () => {
      const [id, other] = [member(), member()];
      matching.handlers.set('getMatch', () => ({
        match: { matchId: MATCH, otherAccountId: other },
      }));
      disclosure.handlers.set('grantDisclosure', () => ({ grantId: MATCH }));
      const response = await gql(gateway.url, SHARE, {
        ...(await as(id)),
        variables: { m: MATCH, s: 'CONDITIONS_ONLY' },
      });
      expect(response.body.data).toEqual({ shareHealthCard: true });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(matching.calls.at(-1)?.request).toEqual({ accountId: id, matchId: MATCH });
      expect(lastCall('grantDisclosure')?.request).toEqual({
        subjectAccountId: id,
        viewerAccountId: other,
        scope: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
      });
    });

    it("refuses an ended, unknown or someone else's match, like the vault does", async () => {
      matching.handlers.set('getMatch', () => {
        throw new GrpcFailure(status.NOT_FOUND, 'That match was not found.');
      });
      const before = disclosure.calls.length;
      const response = await gql(gateway.url, SHARE, {
        ...(await as(member())),
        variables: { m: MATCH, s: 'FULL' },
      });
      expect(response.body.errors?.map((e) => [e.message, e.extensions?.code])).toEqual([
        ['You can share only with a current match.', 'FAILED_PRECONDITION'],
      ]);
      expect(disclosure.calls.length).toBe(before);
    });

    it('rejects a malformed match id before asking anyone', async () => {
      const before = matching.calls.length;
      const response = await gql(gateway.url, SHARE, {
        ...(await as(member())),
        variables: { m: 'not-a-match', s: 'FULL' },
      });
      expect(codes(response)).toEqual(['BAD_USER_INPUT']);
      expect(matching.calls.length).toBe(before);
    });
  });
});

describe('other members', () => {
  const OF = `query($a: ID!) { healthProfileOf(accountId: $a) { conditions { code status } freeText scope leaseExpiresAt } }`;

  it('is null whenever the viewer is not permitted', async () => {
    disclosure.handlers.set('viewHealthProfile', () => ({ allowed: false }));
    const id = member();
    const subject = member();
    const response = await gql(gateway.url, OF, { ...(await as(id)), variables: { a: subject } });
    expect(response.body.data).toEqual({ healthProfileOf: null });
    expect(lastCall('viewHealthProfile')?.request).toMatchObject({
      viewerAccountId: id,
      subjectAccountId: subject,
      purpose: Purpose.PURPOSE_PROFILE_VIEW,
    });
  });

  it('passes through what the viewer may see, with its lease', async () => {
    disclosure.handlers.set('viewHealthProfile', () => ({
      allowed: true,
      profile: {
        conditions: [{ code: 'asthma', status: ConditionStatus.CONDITION_STATUS_IN_REMISSION }],
        freeText: '',
        note: '',
        scope: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
        leaseExpiresAt: new Date(1_800_000_000_000),
      },
    }));
    const response = await gql(gateway.url, OF, {
      ...(await as(member())),
      variables: { a: member() },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body.data?.['healthProfileOf']).toEqual({
      conditions: [{ code: 'asthma', status: 'IN_REMISSION' }],
      freeText: null,
      scope: 'CONDITIONS_ONLY',
      leaseExpiresAt: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it('rejects an id that is not one', async () => {
    const response = await gql(gateway.url, OF, {
      ...(await as(member())),
      variables: { a: 'nope' },
    });
    expect(codes(response)).toEqual(['BAD_USER_INPUT']);
  });
});

describe('who has seen it', () => {
  it('names viewers through the profile service, and leaves out who it cannot show', async () => {
    const id = member();
    const shown = member();
    const gone = member();
    disclosure.handlers.set('listHealthViewers', () => ({
      viewers: [
        {
          viewerAccountId: shown,
          lastViewedAt: new Date(1_700_000_000_000),
          viewCount: 2,
          hasActiveGrant: true,
        },
        {
          viewerAccountId: gone,
          lastViewedAt: new Date(1_690_000_000_000),
          viewCount: 1,
          hasActiveGrant: false,
        },
      ],
      nextPageToken: '',
    }));
    profile.handlers.set('getCatalogue', () => ({
      prompts: [{ id: 'laugh', question: 'Q?' }],
      interests: [],
    }));
    profile.handlers.set('getPublicProfiles', () => ({
      profiles: [
        {
          accountId: shown,
          displayName: 'Thandi',
          age: 31,
          bio: '',
          areaLabel: 'Durban',
          prompts: [{ promptId: 'laugh', answer: 'A' }],
          verified: true,
          photos: [],
        },
      ],
    }));
    const response = await gql(
      gateway.url,
      `{ healthViewers { viewer { id displayName prompts { question } } lastViewedAt viewCount hasActiveGrant } }`,
      await as(id),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body.data?.['healthViewers']).toEqual([
      {
        viewer: { id: shown, displayName: 'Thandi', prompts: [{ question: 'Q?' }] },
        lastViewedAt: new Date(1_700_000_000_000).toISOString(),
        viewCount: 2,
        hasActiveGrant: true,
      },
      {
        viewer: null,
        lastViewedAt: new Date(1_690_000_000_000).toISOString(),
        viewCount: 1,
        hasActiveGrant: false,
      },
    ]);
    expect(lastCall('listHealthViewers')?.request).toEqual({
      subjectAccountId: id,
      pageSize: 50,
      pageToken: '',
    });
  });
});

describe('rate limits', () => {
  it('limits health changes per member, with a message that does not mention health', async () => {
    const id = member();
    disclosure.handlers.set('setFilterPreferences', () => ({}));
    const session = await as(id);
    for (let i = 0; i < RATE_LIMITS.healthWritesPerAccount.limit; i += 1) {
      await gql(gateway.url, `mutation { setHealthFilters(conditionCodes: []) }`, session);
    }
    const refused = await gql(
      gateway.url,
      `mutation { setHealthFilters(conditionCodes: []) }`,
      session,
    );
    expect(refused.body.errors?.[0]).toMatchObject({
      message: 'Too many requests. Try again later.',
      extensions: { code: 'RATE_LIMITED' },
    });
  });
});
