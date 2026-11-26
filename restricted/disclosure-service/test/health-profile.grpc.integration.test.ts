import { randomUUID } from 'node:crypto';
import { ConditionStatus, Visibility } from '@chronos/contracts/disclosure';
import { runMigrations } from '@chronos/vault-db';
import { status } from '@grpc/grpc-js';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVALID_PROFILE, PROFILE_CHANGED } from '../src/health/health-profile.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import {
  grpcError,
  startService,
  type DisclosureClient,
  type WireProfile,
} from './support/service.js';

let db: TestDatabase;
let client: DisclosureClient;
let stop: () => Promise<void>;

const LIVING_WITH = ConditionStatus.CONDITION_STATUS_LIVING_WITH;
const SURVIVOR = ConditionStatus.CONDITION_STATUS_SURVIVOR;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  ({ client, stop } = await startService(db.url));
});

afterAll(async () => {
  await stop();
  await db.stop();
});

const save = (accountId: string, profile: WireProfile, expectedVersion = 0) =>
  call(client.upsertHealthProfile({ accountId, profile, expectedVersion }));
const own = (accountId: string) => call(client.getOwnHealthProfile({ accountId }));

async function auditRows(accountId: string) {
  const { rows } = await db.pool.query<{ purpose: string; decision: string; reason: string }>(
    `select l.purpose, l.decision, l.reason
       from vault.health_access_log l join vault.subject_map m using (vault_id)
      where m.account_id = $1 and l.accessor = $2 order by l.id`,
    [accountId, `account:${accountId}`],
  );
  return rows;
}

describe('ListConditionTaxonomy', () => {
  it('lists the active conditions in label order with "other" last', async () => {
    const { entries = [] } = await call(client.listConditionTaxonomy({}));
    expect(entries).toHaveLength(24);
    expect(entries[0]).toEqual({ code: 'asthma', labelEn: 'Asthma', active: true });
    expect(entries.at(-1)).toEqual({
      code: 'other',
      labelEn: 'Other (in my own words)',
      active: true,
    });
  });
});

describe('own health profile', () => {
  it('returns nothing, and creates nothing, for a member with no profile', async () => {
    const accountId = randomUUID();
    expect((await own(accountId)).profile).toBeUndefined();
    const { rows } = await db.pool.query('select 1 from vault.subject_map where account_id = $1', [
      accountId,
    ]);
    expect(rows).toEqual([]);
  });

  it('saves and reads back the profile, hidden by default, and audits the read', async () => {
    const accountId = randomUUID();
    const profile = {
      conditions: [
        { code: 't1d', status: LIVING_WITH },
        { code: 'other', status: SURVIVOR },
      ],
      freeText: '  Synthetic own words  ',
      note: 'Synthetic note',
    };
    expect(await save(accountId, profile)).toEqual({ version: 1 });

    const read = await own(accountId);
    expect(read.profile).toEqual({
      profile: { ...profile, freeText: 'Synthetic own words' },
      visibility: Visibility.VISIBILITY_HIDDEN,
      filterOptIn: false,
      version: 1,
    });
    expect(await auditRows(accountId)).toEqual([
      { purpose: 'profile_view', decision: 'allow', reason: 'self' },
    ]);
  });

  it('bumps the version and refuses a stale or duplicate save', async () => {
    const accountId = randomUUID();
    const v1 = { conditions: [{ code: 'asthma', status: LIVING_WITH }] };
    const v2 = { conditions: [{ code: 'asthma', status: SURVIVOR }] };
    await save(accountId, v1);
    expect(await save(accountId, v2, 1)).toEqual({ version: 2 });

    const conflict = { code: status.ABORTED, details: PROFILE_CHANGED };
    expect(await grpcError(save(accountId, v1, 1))).toEqual(conflict);
    expect(await grpcError(save(accountId, v1, 0))).toEqual(conflict);
    expect((await own(accountId)).profile?.profile).toEqual({ ...v2, freeText: '', note: '' });
  });

  it('can be cleared to no conditions', async () => {
    const accountId = randomUUID();
    await save(accountId, { conditions: [{ code: 'lupus', status: LIVING_WITH }] });
    await save(accountId, { conditions: [] }, 1);
    // An empty list is absent on the wire.
    expect((await own(accountId)).profile?.profile).toEqual({ freeText: '', note: '' });
  });

  const tooMany = Array.from({ length: 11 }, (_, i) => ({
    code:
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
      ][i] ?? '',
    status: LIVING_WITH,
  }));
  it.each<[string, WireProfile]>([
    ['an unknown condition', { conditions: [{ code: 'not_on_the_list', status: LIVING_WITH }] }],
    [
      'a condition twice',
      {
        conditions: [
          { code: 'hiv', status: LIVING_WITH },
          { code: 'hiv', status: SURVIVOR },
        ],
      },
    ],
    ['"other" without own words', { conditions: [{ code: 'other', status: LIVING_WITH }] }],
    [
      '"other" with only spaces',
      { conditions: [{ code: 'other', status: LIVING_WITH }], freeText: '   ' },
    ],
    ['no status', { conditions: [{ code: 'hiv', status: 0 }] }],
    ['an unknown status', { conditions: [{ code: 'hiv', status: 99 }] }],
    ['own words over 500 characters', { conditions: [], freeText: 'x'.repeat(501) }],
    ['a note over 500 characters', { conditions: [], note: 'x'.repeat(501) }],
  ])('rejects %s with a fixed message', async (_name, profile) => {
    expect(await grpcError(save(randomUUID(), profile))).toEqual({
      code: status.INVALID_ARGUMENT,
      details: INVALID_PROFILE,
    });
  });

  it('rejects more than 10 conditions and a bad account id', async () => {
    expect((await grpcError(save(randomUUID(), { conditions: tooMany }))).code).toBe(
      status.INVALID_ARGUMENT,
    );
    expect((await grpcError(own('not-a-uuid'))).code).toBe(status.INVALID_ARGUMENT);
  });

  it('accepts exactly 10 conditions and 500 characters', async () => {
    const profile = {
      conditions: tooMany.slice(0, 10),
      freeText: 'x'.repeat(500),
      note: 'y'.repeat(500),
    };
    expect(await save(randomUUID(), profile)).toEqual({ version: 1 });
  });
});

describe('retired conditions (M2.2 decision)', () => {
  const RETIRED = 'cystic_fibrosis';
  const retire = (active: boolean) =>
    db.pool.query('update vault.condition_taxonomy set active = $1 where code = $2', [
      active,
      RETIRED,
    ]);

  it('lets members keep a retired condition, but nobody can newly add it', async () => {
    const keeper = randomUUID();
    await save(keeper, { conditions: [{ code: RETIRED, status: LIVING_WITH }] });
    await retire(false);
    try {
      const listed = await call(client.listConditionTaxonomy({}));
      expect(listed.entries?.map((e) => e.code)).not.toContain(RETIRED);
      const all = await call(client.listConditionTaxonomy({ includeRetired: true }));
      expect(all.entries?.find((e) => e.code === RETIRED)).toMatchObject({ active: false });

      // Keeping it while changing the rest of the profile works, and the check is audited.
      const kept = {
        conditions: [
          { code: RETIRED, status: SURVIVOR },
          { code: 'asthma', status: LIVING_WITH },
        ],
      };
      expect(await save(keeper, kept, 1)).toEqual({ version: 2 });
      expect((await auditRows(keeper)).map((r) => r.reason)).toEqual(['self_update']);

      const rejected = { code: status.INVALID_ARGUMENT, details: INVALID_PROFILE };
      // A new member cannot add it...
      expect(
        await grpcError(
          save(randomUUID(), { conditions: [{ code: RETIRED, status: LIVING_WITH }] }),
        ),
      ).toEqual(rejected);
      // ...nor can the keeper once they have removed it.
      await save(keeper, { conditions: [{ code: 'asthma', status: LIVING_WITH }] }, 2);
      expect(await grpcError(save(keeper, kept, 3))).toEqual(rejected);
    } finally {
      await retire(true);
    }
  });
});

describe('storage', () => {
  it('holds the profile only as ciphertext', async () => {
    const accountId = randomUUID();
    const words = `synthetic-${randomUUID()}`;
    await save(accountId, {
      conditions: [{ code: 'sickle_cell_disease', status: LIVING_WITH }],
      freeText: words,
      note: words,
    });
    // Every member-data table, as text, must contain none of what was saved.
    const { rows } = await db.pool.query<{ dump: string }>(
      `select string_agg(t::text, ' ') as dump from (
         select row_to_json(p)::text as t from vault.health_profiles p
         union all select row_to_json(k)::text from vault.subject_keys k
         union all select row_to_json(m)::text from vault.subject_map m
         union all select row_to_json(l)::text from vault.health_access_log l
         union all select row_to_json(g)::text from vault.disclosure_grants g
         union all select row_to_json(f)::text from vault.filter_preferences f) x`,
    );
    const dump = rows[0]?.dump ?? '';
    expect(dump).toContain(accountId); // the dump is real
    for (const plaintext of [words, 'sickle_cell_disease', 'living_with']) {
      expect(dump).not.toContain(plaintext);
    }
    // Also not hex-encoded (bytea's text form).
    expect(dump).not.toContain(Buffer.from(words).toString('hex'));
  });

  it('cannot open a profile copied onto another member', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    await save(owner, { conditions: [{ code: 'hiv', status: LIVING_WITH }] });
    await save(other, { conditions: [] });
    await db.pool.query(
      `update vault.health_profiles t set payload_ct = s.payload_ct, payload_nonce = s.payload_nonce
         from vault.health_profiles s, vault.subject_map so, vault.subject_map tm
        where so.account_id = $1 and s.vault_id = so.vault_id
          and tm.account_id = $2 and t.vault_id = tm.vault_id`,
      [owner, other],
    );
    expect(await grpcError(own(other))).toEqual({
      code: status.INTERNAL,
      details: 'Internal error',
    });
  });
});

describe('not yet implemented', () => {
  it('answers UNIMPLEMENTED for calls from later tasks', async () => {
    expect((await grpcError(call(client.viewHealthProfile({})))).code).toBe(status.UNIMPLEMENTED);
  });
});
