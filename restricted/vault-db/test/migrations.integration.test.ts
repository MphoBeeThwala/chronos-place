import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;

const bytes = (): Buffer => randomBytes(32);

/** Runs `fn` as the Disclosure Service's role, in a transaction that is rolled back unless kept. */
async function asService<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  { keep = false } = {},
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role disclosure_service');
    const result = await fn(client);
    await client.query(keep ? 'commit' : 'rollback');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Creates a member in the vault as the service would and returns their vault id. */
async function newSubject(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ vault_id: string }>(
    `insert into vault.subject_map (account_id) values ($1) returning vault_id`,
    [randomUUID()],
  );
  return rows[0]?.vault_id ?? '';
}

async function logRead(
  client: pg.PoolClient,
  vaultId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const row = {
    accessor: `account:${randomUUID()}`,
    purpose: 'profile_view',
    decision: 'deny',
    reason: 'no_grant',
    ...overrides,
  };
  await client.query(
    `insert into vault.health_access_log (vault_id, accessor, purpose, decision, reason)
     values ($1, $2, $3, $4, $5)`,
    [vaultId, row.accessor, row.purpose, row.decision, row.reason],
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

describe('vault migrations', () => {
  it('creates exactly the vault tables in their own schema', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'vault' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'condition_taxonomy',
      'disclosure_grants',
      'filter_preferences',
      'health_access_log',
      'health_profiles',
      'subject_keys',
      'subject_map',
    ]);
  });

  it('is safe to run again (forward-only, already applied)', async () => {
    await expect(runMigrations(db.url)).resolves.toBeUndefined();
  });

  it('stores health content and keys only as bytes', async () => {
    const { rows } = await db.pool.query<{ column: string; data_type: string }>(
      `select table_name || '.' || column_name as column, data_type
         from information_schema.columns where table_schema = 'vault'`,
    );
    const types = new Map(rows.map((r) => [r.column, r.data_type]));
    for (const column of [
      'health_profiles.payload_ct',
      'health_profiles.payload_nonce',
      'filter_preferences.payload_ct',
      'filter_preferences.payload_nonce',
      'subject_keys.wrapped_dek',
    ]) {
      expect(types.get(column), column).toBe('bytea');
    }
    // Every text column is a constrained code or a key reference. A new text column needs review.
    const textColumns = rows
      .filter((r) => r.data_type === 'text')
      .map((r) => r.column)
      .sort();
    expect(textColumns).toEqual([
      'condition_taxonomy.code',
      'condition_taxonomy.label_en',
      'disclosure_grants.scope',
      'health_access_log.accessor',
      'health_access_log.decision',
      'health_access_log.purpose',
      'health_access_log.reason',
      'health_profiles.visibility',
      'subject_keys.kms_key_arn',
    ]);
  });
});

describe('condition list', () => {
  it('seeds the approved provisional list, all active, with "other"', async () => {
    const { rows } = await db.pool.query<{ code: string; active: boolean }>(
      `select code, active from vault.condition_taxonomy order by code`,
    );
    expect(rows).toHaveLength(24);
    expect(rows.every((r) => r.active)).toBe(true);
    expect(rows.map((r) => r.code)).toEqual(
      expect.arrayContaining(['hiv', 't1d', 'cancer', 'other']),
    );
  });
});

describe('roles and grants', () => {
  it('creates both roles without login', async () => {
    const { rows } = await db.pool.query<{ rolname: string; rolcanlogin: boolean }>(
      `select rolname, rolcanlogin from pg_roles
        where rolname in ('vault_owner', 'disclosure_service') order by 1`,
    );
    expect(rows).toEqual([
      { rolname: 'disclosure_service', rolcanlogin: false },
      { rolname: 'vault_owner', rolcanlogin: false },
    ]);
  });

  it('gives the Disclosure Service exactly the planned table privileges', async () => {
    const { rows } = await db.pool.query<{ table_name: string; privileges: string }>(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
         from information_schema.role_table_grants
        where table_schema = 'vault' and grantee = 'disclosure_service'
        group by table_name order by table_name`,
    );
    const crud = 'DELETE,INSERT,SELECT,UPDATE';
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.privileges]))).toEqual({
      condition_taxonomy: 'SELECT',
      disclosure_grants: crud,
      filter_preferences: crud,
      health_access_log: 'INSERT,SELECT',
      health_profiles: crud,
      subject_keys: crud,
      subject_map: crud,
    });
  });

  it('grants nothing in the vault to PUBLIC', async () => {
    const { rows } = await db.pool.query(
      `select 1 from information_schema.role_table_grants
        where table_schema = 'vault' and grantee = 'PUBLIC'`,
    );
    expect(rows).toEqual([]);
  });

  it('hands every vault table to the owner role', async () => {
    const { rows } = await db.pool.query<{ tableowner: string }>(
      `select distinct tableowner from pg_tables where schemaname = 'vault'`,
    );
    expect(rows).toEqual([{ tableowner: 'vault_owner' }]);
  });

  it('keeps the service out of migration bookkeeping and schema changes', async () => {
    await expect(
      asService((c) => c.query('select * from drizzle.vault_migrations')),
    ).rejects.toThrow(/permission denied/);
    await expect(asService((c) => c.query('create table vault.extra (id int)'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asService((c) => c.query('create table public.extra (id int)'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asService((c) => c.query('alter table vault.health_access_log disable trigger all')),
    ).rejects.toThrow(/must be owner/);
  });

  it('lets the service read the condition list but not change it', async () => {
    await expect(
      asService((c) => c.query('select * from vault.condition_taxonomy')),
    ).resolves.toBeDefined();
    await expect(
      asService((c) =>
        c.query(`insert into vault.condition_taxonomy (code, label_en) values ('x', 'X')`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('health access log', () => {
  it('lets the service append and read', async () => {
    const count = await asService(async (c) => {
      const vaultId = await newSubject(c);
      await logRead(c, vaultId);
      await logRead(c, vaultId, { decision: 'allow', reason: 'granted' });
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from vault.health_access_log where vault_id = $1`,
        [vaultId],
      );
      return rows[0]?.n;
    });
    expect(count).toBe('2');
  });

  it.each([
    ['update', `update vault.health_access_log set decision = 'allow'`],
    ['delete', `delete from vault.health_access_log`],
    ['truncate', `truncate vault.health_access_log`],
  ])('refuses a %s by the service', async (_name, statement) => {
    await expect(
      asService(async (c) => {
        await logRead(c, await newSubject(c));
        await c.query(statement);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it.each([
    ['update', `update vault.health_access_log set decision = 'allow'`],
    ['delete', `delete from vault.health_access_log`],
    ['truncate', `truncate vault.health_access_log`],
  ])('refuses a %s even by the owner', async (_name, statement) => {
    await asService(async (c) => logRead(c, await newSubject(c)), { keep: true });
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role vault_owner');
      await expect(client.query(statement)).rejects.toThrow(/append-only/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it.each([
    ['free text in reason', { reason: 'viewer asked about their condition' }],
    ['no reason', { reason: null }],
    ['a free-text accessor', { accessor: 'Dr Smith from support' }],
    ['an accessor without a kind', { accessor: randomUUID() }],
    ['an unknown accessor kind', { accessor: `support:${randomUUID()}` }],
    ['an account accessor that is not an id', { accessor: 'account:someone' }],
    ['an unknown purpose', { purpose: 'analytics' }],
    ['an unknown decision', { decision: 'maybe' }],
  ])('rejects %s', async (_name, overrides) => {
    await expect(
      asService(async (c) => logRead(c, await newSubject(c), overrides)),
    ).rejects.toThrow(/health_access_log_\w+_check|null value/);
  });

  it.each([`account:${randomUUID()}`, `staff:${randomUUID()}`, 'service:erasure-job'])(
    'accepts the accessor %s',
    async (accessor) => {
      await expect(
        asService(async (c) => logRead(c, await newSubject(c), { accessor })),
      ).resolves.toBeUndefined();
    },
  );
});

describe('health profiles and grants', () => {
  it('defaults a new profile to hidden and rejects an unknown visibility', async () => {
    const visibility = await asService(async (c) => {
      const vaultId = await newSubject(c);
      const { rows } = await c.query<{ visibility: string }>(
        `insert into vault.health_profiles (vault_id, payload_ct, payload_nonce)
         values ($1, $2, $3) returning visibility`,
        [vaultId, bytes(), bytes()],
      );
      return rows[0]?.visibility;
    });
    expect(visibility).toBe('hidden');
    await expect(
      asService(async (c) =>
        c.query(
          `insert into vault.health_profiles (vault_id, payload_ct, payload_nonce, visibility)
           values ($1, $2, $3, 'everyone')`,
          [await newSubject(c), bytes(), bytes()],
        ),
      ),
    ).rejects.toThrow(/health_profiles_visibility_check/);
  });

  it('allows one live grant per viewer, and a new one after revoking', async () => {
    await asService(async (c) => {
      const vaultId = await newSubject(c);
      const viewer = randomUUID();
      const grant = `insert into vault.disclosure_grants (vault_id, viewer_account_id, scope)
                     values ($1, $2, 'conditions_only')`;
      await c.query(grant, [vaultId, viewer]);
      await c.query('savepoint again');
      await expect(c.query(grant, [vaultId, viewer])).rejects.toThrow(
        /disclosure_grants_active_unique/,
      );
      await c.query('rollback to savepoint again');
      await c.query(`update vault.disclosure_grants set revoked_at = now() where vault_id = $1`, [
        vaultId,
      ]);
      await expect(c.query(grant, [vaultId, viewer])).resolves.toBeDefined();
    });
  });

  it('rejects an unknown grant scope', async () => {
    await expect(
      asService(async (c) =>
        c.query(
          `insert into vault.disclosure_grants (vault_id, viewer_account_id, scope)
           values ($1, $2, 'everything')`,
          [await newSubject(c), randomUUID()],
        ),
      ),
    ).rejects.toThrow(/disclosure_grants_scope_check/);
  });
});

describe('erasure', () => {
  it('removes everything about a member but keeps the pseudonymous audit trail', async () => {
    const remaining = await asService(async (c) => {
      const vaultId = await newSubject(c);
      await c.query(
        `insert into vault.subject_keys (vault_id, wrapped_dek, kms_key_arn) values ($1, $2, 'test-key')`,
        [vaultId, bytes()],
      );
      await c.query(
        `insert into vault.health_profiles (vault_id, payload_ct, payload_nonce) values ($1, $2, $3)`,
        [vaultId, bytes(), bytes()],
      );
      await c.query(
        `insert into vault.filter_preferences (vault_id, payload_ct, payload_nonce) values ($1, $2, $3)`,
        [vaultId, bytes(), bytes()],
      );
      await c.query(
        `insert into vault.disclosure_grants (vault_id, viewer_account_id, scope) values ($1, $2, 'full')`,
        [vaultId, randomUUID()],
      );
      await logRead(c, vaultId);

      await c.query(`delete from vault.subject_map where vault_id = $1`, [vaultId]);

      const { rows } = await c.query<{ table: string; n: string }>(
        `select 'subject_keys' as table, count(*) as n from vault.subject_keys where vault_id = $1
         union all select 'health_profiles', count(*) from vault.health_profiles where vault_id = $1
         union all select 'filter_preferences', count(*) from vault.filter_preferences where vault_id = $1
         union all select 'disclosure_grants', count(*) from vault.disclosure_grants where vault_id = $1
         union all select 'health_access_log', count(*) from vault.health_access_log where vault_id = $1`,
        [vaultId],
      );
      return Object.fromEntries(rows.map((r) => [r.table, r.n]));
    });
    expect(remaining).toEqual({
      subject_keys: '0',
      health_profiles: '0',
      filter_preferences: '0',
      disclosure_grants: '0',
      health_access_log: '1',
    });
  });
});
