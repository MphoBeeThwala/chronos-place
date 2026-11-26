import { randomBytes, randomUUID } from 'node:crypto';
import { createEvent } from '@chronos/contracts/events';
import { KeyDestroyedError, SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzleErasureStore } from '../src/erasure/erasure-store.js';
import { ErasureService, OVERDUE_AFTER_MS } from '../src/erasure/erasure.service.js';
import { IDENTITY_KEY_PURPOSE, PHONE_FIELD } from '../src/otp/otp.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { FakeClock } from './support/otp-fakes.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});
afterAll(async () => {
  await db.stop();
});

const logLines: string[] = [];
const logger = createLogger({
  service: 'identity-test',
  destination: { write: (line: string) => logLines.push(line) },
});
let clock: FakeClock;
let keyring: SubjectKeyring;
let forgotten: string[];

beforeEach(() => {
  clock = new FakeClock();
  forgotten = [];
  logLines.length = 0;
  keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new DrizzleAccountKeyStore(drizzle(db.pool)),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });
});

const service = (services: string[] = ['profile']) =>
  new ErasureService({
    store: new DrizzleErasureStore(drizzle(db.pool)),
    keyring,
    services,
    forgetVerification: (id) => {
      forgotten.push(id);
      return Promise.resolve();
    },
    logger,
    now: clock.now,
  });

const confirmed = (accountId: string, svc: 'profile' | 'matching') =>
  createEvent('account.erasure_confirmed', svc, { accountId, service: svc });

/**
 * An account whose deletion has started, holding one of everything identity stores: a sealed
 * number, a date of birth, a session with a refresh token, consents, a deletion code and a
 * verification attempt (its capture already purged unless `withCapture`).
 */
async function pendingAccount(options: { withCapture?: boolean; requestedAt?: Date } = {}) {
  const id = randomUUID();
  const sealed = await keyring.encrypt(id, PHONE_FIELD, '+27820009999');
  const q = (text: string, values: unknown[]) => db.pool.query(text, values);
  await q(
    `insert into identity.accounts (id, status, phone_ciphertext, phone_nonce, date_of_birth,
       verified_at, erasure_requested_at)
     values ($1, 'pending_erasure', $2, $3, '1990-04-02', now(), $4)`,
    [
      id,
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.nonce),
      options.requestedAt ?? clock.now(),
    ],
  );
  const session = randomUUID();
  await q(
    `insert into identity.sessions (id, account_id, device_hash, expires_at)
     values ($1, $2, $3, now() + interval '30 days')`,
    [session, id, randomBytes(32)],
  );
  await q(
    `insert into identity.refresh_tokens (id, session_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '30 days')`,
    [randomUUID(), session, randomBytes(32)],
  );
  for (const type of ['terms', 'privacy']) {
    await q(
      `insert into identity.consent_records (id, account_id, consent_type, policy_version, granted, recorded_at)
       values ($1, $2, $3, 'v1', true, now())`,
      [randomUUID(), id, type],
    );
  }
  await q(
    `insert into identity.deletion_challenges (id, account_id, code_hash, expires_at, consumed_at)
     values ($1, $2, $3, now(), now())`,
    [randomUUID(), id, randomBytes(32)],
  );
  await q(
    `insert into identity.verification_attempts (id, account_id, provider, outcome, capture_key)
     values ($1, $2, 'fake', 'passed', $3)`,
    [randomUUID(), id, options.withCapture ? `captures/${id}` : null],
  );
  await q('insert into identity.vault_erasure_requests (id, account_id) values ($1, $2)', [
    randomUUID(),
    id,
  ]);
  return id;
}

/** How many rows identity still holds for the account, per table. */
async function remaining(id: string) {
  const { rows } = await db.pool.query<Record<string, number>>(
    `select
       (select count(*) from identity.sessions where account_id = $1)::int as sessions,
       (select count(*) from identity.refresh_tokens r join identity.sessions s on s.id = r.session_id
         where s.account_id = $1)::int as refresh_tokens,
       (select count(*) from identity.consent_records where account_id = $1)::int as consents,
       (select count(*) from identity.deletion_challenges where account_id = $1)::int as codes,
       (select count(*) from identity.verification_attempts where account_id = $1)::int as verifications,
       (select count(*) from identity.erasure_confirmations where account_id = $1)::int as confirmations,
       (select count(*) from identity.account_keys where subject_id = $1)::int as keys`,
    [id],
  );
  return rows[0];
}

const accountRow = async (id: string) =>
  (await db.pool.query('select * from identity.accounts where id = $1', [id])).rows[0] as Record<
    string,
    unknown
  >;

describe('finishing account erasure (ADR-0025 e)', () => {
  it('waits for every expected service, then leaves only the bare id', async () => {
    const id = await pendingAccount();
    const erasure = service(['profile', 'matching']);

    await erasure.confirmed(confirmed(id, 'profile'));
    expect(await erasure.runOnce()).toBe(0);
    expect((await accountRow(id))['status']).toBe('pending_erasure');

    await erasure.confirmed(confirmed(id, 'matching'));
    expect(await erasure.runOnce()).toBe(1);

    const row = await accountRow(id);
    expect(row).toMatchObject({
      status: 'erased',
      phone_lookup: null,
      phone_ciphertext: null,
      phone_nonce: null,
      date_of_birth: null,
      verified_at: null,
    });
    expect(row['erased_at']).toBeInstanceOf(Date);
    expect(await remaining(id)).toEqual({
      sessions: 0,
      refresh_tokens: 0,
      consents: 0,
      codes: 0,
      verifications: 0,
      confirmations: 0,
      keys: 0,
    });
    // The data key is shredded: the sealed number could never be read again.
    await expect(
      keyring.decrypt(id, PHONE_FIELD, {
        ciphertext: new Uint8Array(1),
        nonce: new Uint8Array(12),
      }),
    ).rejects.toBeInstanceOf(KeyDestroyedError);
    const { rows } = await db.pool.query(
      "select count(*)::int as n from identity.outbox where topic = 'account.erased' and partition_key = $1",
      [id],
    );
    expect(rows[0]).toEqual({ n: 1 });
    // The health-erasure request stays queued for the Disclosure Service (M2).
    const vault = await db.pool.query(
      'select count(*)::int as n from identity.vault_erasure_requests where account_id = $1',
      [id],
    );
    expect(vault.rows[0]).toEqual({ n: 1 });
  });

  it('keeps the key until verification files are deleted', async () => {
    const id = await pendingAccount({ withCapture: true });
    const erasure = service();
    await erasure.confirmed(confirmed(id, 'profile'));

    expect(await erasure.runOnce()).toBe(0);
    expect(forgotten).toEqual([id]);
    expect(await remaining(id)).toMatchObject({ keys: 1 });

    // The verification worker deletes the capture and vendor copy, then the next run finishes.
    await db.pool.query(
      'update identity.verification_attempts set capture_key = null where account_id = $1',
      [id],
    );
    expect(await erasure.runOnce()).toBe(1);
    expect((await accountRow(id))['status']).toBe('erased');
  });

  it('ignores repeats, unexpected services and accounts not being erased', async () => {
    const id = await pendingAccount();
    const erasure = service();
    await erasure.confirmed(confirmed(id, 'matching')); // not expected here
    expect(await erasure.runOnce()).toBe(0);

    await erasure.confirmed(confirmed(id, 'profile'));
    await erasure.confirmed(confirmed(id, 'profile'));
    expect(await erasure.runOnce()).toBe(1);
    // A late confirmation after erasure changes nothing.
    await erasure.confirmed(confirmed(id, 'profile'));
    expect(await remaining(id)).toMatchObject({ confirmations: 0 });
    expect(await erasure.runOnce()).toBe(0);

    const active = randomUUID();
    await db.pool.query("insert into identity.accounts (id, status) values ($1, 'active')", [
      active,
    ]);
    await erasure.confirmed(confirmed(active, 'profile'));
    expect(await remaining(active)).toMatchObject({ confirmations: 0 });
  });

  it('flags erasure still waiting after 7 days, by count only', async () => {
    const old = await pendingAccount({
      requestedAt: new Date(clock.now().getTime() - OVERDUE_AFTER_MS - 60_000),
    });
    await service(['profile', 'matching']).runOnce();
    const warning = logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'account erasure overdue');
    expect(warning?.['count']).toBeGreaterThanOrEqual(1);
    expect(logLines.join('\n')).not.toContain(old);
  });
});
