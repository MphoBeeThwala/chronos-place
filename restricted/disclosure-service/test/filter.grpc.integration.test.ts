import { randomUUID } from 'node:crypto';
import { ConditionStatus, FilterOutcome, Visibility } from '@chronos/contracts/disclosure';
import { runMigrations } from '@chronos/vault-db';
import { status } from '@grpc/grpc-js';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILTER_K, INVALID_FILTERS } from '../src/health/filter.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { grpcError, startService, type DisclosureClient } from './support/service.js';

let db: TestDatabase;
let client: DisclosureClient;
let stop: () => Promise<void>;

const LIVING_WITH = ConditionStatus.CONDITION_STATUS_LIVING_WITH;
const {
  FILTER_OUTCOME_OK: OK,
  FILTER_OUTCOME_BELOW_THRESHOLD: BELOW,
  FILTER_OUTCOME_VIEWER_NOT_SHARING: NOT_SHARING,
  FILTER_OUTCOME_NO_PREFERENCES: NO_PREFERENCES,
} = FilterOutcome;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  ({ client, stop } = await startService(db.url));
});

afterAll(async () => {
  await stop();
  await db.stop();
});

/** A member with these conditions and this setting (by default: everyone, opted in to filters). */
async function member(
  codes: string[],
  { visibility = Visibility.VISIBILITY_PROFILE, filterOptIn = true } = {},
): Promise<string> {
  const accountId = randomUUID();
  await call(
    client.upsertHealthProfile({
      accountId,
      profile: { conditions: codes.map((code) => ({ code, status: LIVING_WITH })) },
    }),
  );
  await call(client.setVisibility({ accountId, visibility, filterOptIn }));
  return accountId;
}

/** A viewer who shares the same way and filters for `wanted`. */
async function viewer(wanted: string[]): Promise<string> {
  const id = await member(['asthma']);
  await call(client.setFilterPreferences({ accountId: id, wantedConditionCodes: wanted }));
  return id;
}

const many = (n: number, codes: string[]) =>
  Promise.all(Array.from({ length: n }, () => member(codes)));
const filter = (viewerAccountId: string, candidateAccountIds: string[]) =>
  call(client.filterEligibleSubjects({ viewerAccountId, candidateAccountIds }));

describe('M2.6 acceptance', () => {
  it('returns nothing below the threshold, and the matches from 20 up', async () => {
    const v = await viewer(['epilepsy']);
    const matching = await many(FILTER_K - 1, ['epilepsy']);
    expect(await filter(v, matching)).toEqual({ outcome: BELOW });

    const twentieth = await member(['epilepsy']);
    const candidates = [twentieth, ...matching];
    expect(await filter(v, candidates)).toEqual({ outcome: OK, eligibleAccountIds: candidates });
  });

  it('refuses filters to a viewer who does not share their own profile the same way', async () => {
    const candidates = await many(FILTER_K, ['epilepsy']);
    const hidden = await member(['asthma'], { visibility: Visibility.VISIBILITY_HIDDEN });
    const noOptIn = await member(['asthma'], { filterOptIn: false });
    const matchesOnly = await member(['asthma'], { visibility: Visibility.VISIBILITY_MATCH_ONLY });
    for (const id of [hidden, noOptIn, matchesOnly]) {
      await call(
        client.setFilterPreferences({ accountId: id, wantedConditionCodes: ['epilepsy'] }),
      );
      expect(await filter(id, candidates)).toEqual({ outcome: NOT_SHARING });
    }
  });
});

describe('who counts', () => {
  it('only candidates who chose everyone and opted in, with any wanted condition', async () => {
    const v = await viewer(['t1d', 'lupus']);
    const t1d = await many(10, ['t1d']);
    const lupus = await many(10, ['lupus', 'asthma']);
    const notOptedIn = await member(['t1d'], { filterOptIn: false });
    const matchesOnly = await member(['t1d'], { visibility: Visibility.VISIBILITY_MATCH_ONLY });
    const other = await member(['asthma']);
    const result = await filter(v, [...t1d, notOptedIn, matchesOnly, other, ...lupus, v]);
    expect(result).toEqual({ outcome: OK, eligibleAccountIds: [...t1d, ...lupus] });
    // Without the 20th real match, the two who did not opt in do not tip it over.
    expect(await filter(v, [...t1d, ...lupus.slice(1), notOptedIn, matchesOnly])).toEqual({
      outcome: BELOW,
    });
  });

  it('says "no preferences" without them, whatever the viewer shares, and opens nothing (M3.4)', async () => {
    const candidates = await many(FILTER_K, ['asthma']);
    const sharing = await member(['asthma']);
    const hidden = await member(['asthma'], { visibility: Visibility.VISIBILITY_HIDDEN });
    const nothingInVault = randomUUID();
    const cleared = await viewer(['asthma']);
    await call(client.setFilterPreferences({ accountId: cleared, wantedConditionCodes: [] }));
    const before = await db.pool.query<{ n: string }>(
      'select count(*) as n from vault.health_access_log',
    );
    for (const id of [sharing, hidden, nothingInVault, cleared]) {
      expect(await filter(id, candidates)).toEqual({ outcome: NO_PREFERENCES });
    }
    // No profile was opened, so there is nothing to audit; and the answer is the same whether
    // or not the viewer shares, so it reveals nothing about them.
    const after = await db.pool.query<{ n: string }>(
      'select count(*) as n from vault.health_access_log',
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    // Nobody unknown to the vault is added to it by asking.
    const { rows } = await db.pool.query('select 1 from vault.subject_map where account_id = $1', [
      nothingInVault,
    ]);
    expect(rows).toEqual([]);
  });

  it('gives 19 matches and none the same answer, so counts point at nobody (M3.4 AC)', async () => {
    const v = await viewer(['crohns_disease']);
    const nineteen = await many(FILTER_K - 1, ['crohns_disease']);
    const unrelated = await many(FILTER_K, ['asthma']);
    const answers = [
      await filter(v, nineteen),
      await filter(v, unrelated),
      await filter(v, [...nineteen, ...unrelated]),
      await filter(v, []),
    ];
    for (const answer of answers) expect(answer).toEqual({ outcome: BELOW });
    // Adding one more match changes nothing but the outcome, and then all 20 come back.
    const twentieth = await member(['crohns_disease']);
    const ok = await filter(v, [...unrelated, twentieth, ...nineteen]);
    expect(ok.outcome).toBe(OK);
    expect(new Set(ok.eligibleAccountIds)).toEqual(new Set([twentieth, ...nineteen]));
  });

  it('rejects more than 500 candidates', async () => {
    const v = await viewer(['asthma']);
    const ids = Array.from({ length: 501 }, () => randomUUID());
    expect((await grpcError(filter(v, ids))).code).toBe(status.INVALID_ARGUMENT);
  });

  it('records each candidate read, without showing it as a view', async () => {
    const v = await viewer(['hepatitis_b']);
    const [first, ...rest] = await many(FILTER_K, ['hepatitis_b']);
    if (first === undefined) throw new Error('no candidates');
    await filter(v, [first, ...rest]);
    const { rows } = await db.pool.query<{ reason: string }>(
      `select l.reason from vault.health_access_log l join vault.subject_map m using (vault_id)
        where m.account_id = $1 and l.purpose = 'filter' and l.accessor = $2`,
      [first, `account:${v}`],
    );
    expect(rows).toEqual([{ reason: 'filter_match' }]);
    expect(
      (await call(client.listHealthViewers({ subjectAccountId: first }))).viewers,
    ).toBeUndefined();
  });
});

describe('filter preferences', () => {
  it('round-trips, stored only as ciphertext, and an empty list deletes them', async () => {
    const accountId = await member(['asthma']);
    await call(
      client.setFilterPreferences({
        accountId,
        wantedConditionCodes: ['sickle_cell_disease', 'hiv'],
      }),
    );
    expect(await call(client.getFilterPreferences({ accountId }))).toEqual({
      wantedConditionCodes: ['sickle_cell_disease', 'hiv'],
    });
    const { rows } = await db.pool.query<{ dump: string }>(
      `select row_to_json(f)::text as dump from vault.filter_preferences f
         join vault.subject_map m using (vault_id) where m.account_id = $1`,
      [accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dump).not.toContain('sickle_cell');

    await call(client.setFilterPreferences({ accountId, wantedConditionCodes: [] }));
    expect(await call(client.getFilterPreferences({ accountId }))).toEqual({});
    const { rows: after } = await db.pool.query(
      `select 1 from vault.filter_preferences f join vault.subject_map m using (vault_id)
        where m.account_id = $1`,
      [accountId],
    );
    expect(after).toEqual([]);
  });

  it.each([
    ['"other"', ['other']],
    ['an unknown code', ['not_on_the_list']],
    ['a duplicate', ['hiv', 'hiv']],
    [
      'more than 10',
      [
        'hiv',
        't1d',
        't2d',
        'cancer',
        'epilepsy',
        'lupus',
        'asthma',
        'psoriasis',
        'long_covid',
        'hepatitis_b',
        'hepatitis_c',
      ],
    ],
  ])('rejects %s with a fixed message', async (_name, codes) => {
    const result = await grpcError(
      call(client.setFilterPreferences({ accountId: randomUUID(), wantedConditionCodes: codes })),
    );
    expect(result.code).toBe(status.INVALID_ARGUMENT);
    if (codes.length <= 10) expect(result.details).toBe(INVALID_FILTERS);
  });
});
