import { randomBytes, randomUUID } from 'node:crypto';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { AccountExporter } from '../src/export/account-export.js';
import { IDENTITY_KEY_PURPOSE, PHONE_FIELD } from '../src/otp/otp.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

/** "Download my data", identity's part (ADR-0025 c, h). Synthetic data only. */
let db: TestDatabase;
let keyring: SubjectKeyring;
let exporter: AccountExporter;
const logLines: string[] = [];

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new DrizzleAccountKeyStore(drizzle(db.pool)),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });
  exporter = new AccountExporter({
    db: drizzle(db.pool),
    keyring,
    logger: createLogger({
      service: 'identity-test',
      destination: { write: (l: string) => logLines.push(l) },
    }),
  });
});
afterAll(async () => {
  await db.stop();
});

const PHONE = '+27820004242';

async function account(status = 'active') {
  const id = randomUUID();
  const sealed = await keyring.encrypt(id, PHONE_FIELD, PHONE);
  await db.pool.query(
    `insert into identity.accounts (id, status, phone_lookup, phone_ciphertext, phone_nonce, date_of_birth)
     values ($1, $2, $3, $4, $5, '1991-06-14')`,
    [id, status, randomBytes(32), Buffer.from(sealed.ciphertext), Buffer.from(sealed.nonce)],
  );
  return id;
}

describe('identity export', () => {
  it('returns the member’s own number, date of birth, consents, sessions and checks', async () => {
    const id = await account();
    for (const [type, at] of [
      ['privacy', '2026-11-02T08:00:00Z'],
      ['terms', '2026-11-01T08:00:00Z'],
    ]) {
      await db.pool.query(
        `insert into identity.consent_records (id, account_id, consent_type, policy_version, granted, recorded_at)
         values ($1, $2, $3, 'v1', true, $4)`,
        [randomUUID(), id, type, at],
      );
    }
    await db.pool.query(
      `insert into identity.sessions (id, account_id, device_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days')`,
      [randomUUID(), id, randomBytes(32)],
    );
    await db.pool.query(
      `insert into identity.verification_attempts (id, account_id, provider, outcome, failure, decided_at)
       values ($1, $2, 'fake', 'failed', 'poor_quality', now())`,
      [randomUUID(), id],
    );

    const data = await exporter.export(id);
    expect(data.phone).toBe(PHONE);
    expect(data.dateOfBirth).toEqual({ year: 1991, month: 6, day: 14 });
    // Oldest first.
    expect(data.consents.map((c) => c.type)).toEqual(['terms', 'privacy']);
    expect(data.sessions).toHaveLength(1);
    // Sessions are dates only: never the device hash.
    expect(Object.keys(data.sessions[0] ?? {}).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
    ]);
    expect(data.verifications).toMatchObject([
      { provider: 'fake', outcome: 'failed', failure: 'poor_quality' },
    ]);
  });

  it('refuses an account whose deletion has started', async () => {
    const id = await account('pending_erasure');
    const err = await exporter.export(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('failed_precondition');
  });

  it('logs that an export happened, never what was in it', async () => {
    const id = await account();
    logLines.length = 0;
    await exporter.export(id);
    const logs = logLines.join('\n');
    expect(logs).toContain('account data exported');
    expect(logs).not.toContain(PHONE);
    expect(logs).not.toContain('1991');
  });
});
