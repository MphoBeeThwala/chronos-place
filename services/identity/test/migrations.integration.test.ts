import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;

const bytes = (): Buffer => randomBytes(32);

async function insertAccount(id = randomUUID(), status = 'pending_onboarding'): Promise<string> {
  await db.pool.query(
    `insert into identity.accounts (id, phone_lookup, phone_ciphertext, phone_nonce, status)
     values ($1, $2, $3, $4, $5)`,
    [id, bytes(), bytes(), bytes(), status],
  );
  return id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

describe('identity migrations', () => {
  it('creates every identity table in its own schema', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'identity' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account_keys',
      'accounts',
      'otp_challenges',
      'outbox',
      'refresh_tokens',
      'sessions',
    ]);
  });

  it('is safe to run again (forward-only, already applied)', async () => {
    await expect(runMigrations(db.url)).resolves.toBeUndefined();
  });

  it('has no plaintext phone, code or token column anywhere', async () => {
    const { rows } = await db.pool.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_schema = 'identity'`,
    );
    const sensitive = rows.filter((r) => /phone|code|token/.test(r.column_name));
    expect(sensitive.length).toBeGreaterThan(0);
    for (const column of sensitive) expect(column.data_type, column.column_name).toBe('bytea');
  });

  it('rejects an unknown account status', async () => {
    await expect(insertAccount(randomUUID(), 'deleted')).rejects.toThrow(/accounts_status_check/);
  });

  it('allows one account per phone lookup hash', async () => {
    const lookup = bytes();
    const insert = (id: string) =>
      db.pool.query(
        `insert into identity.accounts (id, phone_lookup, phone_ciphertext, phone_nonce, status)
         values ($1, $2, $3, $4, 'active')`,
        [id, lookup, bytes(), bytes()],
      );
    await insert(randomUUID());
    await expect(insert(randomUUID())).rejects.toThrow(/accounts_phone_lookup_unique/);
  });

  it('removes sessions and refresh tokens with the account', async () => {
    const accountId = await insertAccount();
    const sessionId = randomUUID();
    await db.pool.query(
      `insert into identity.sessions (id, account_id, device_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days')`,
      [sessionId, accountId, bytes()],
    );
    await db.pool.query(
      `insert into identity.refresh_tokens (id, session_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days')`,
      [randomUUID(), sessionId, bytes()],
    );
    await db.pool.query(`delete from identity.accounts where id = $1`, [accountId]);
    const { rows } = await db.pool.query<{ n: string }>(
      `select (select count(*) from identity.sessions where id = $1)
            + (select count(*) from identity.refresh_tokens where session_id = $1) as n`,
      [sessionId],
    );
    expect(rows[0]?.n).toBe('0');
  });
});
