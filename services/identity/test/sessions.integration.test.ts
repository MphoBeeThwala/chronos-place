import { randomBytes } from 'node:crypto';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountStore } from '../src/accounts/account-store.js';
import { AccountService, SIGN_IN_STATUSES } from '../src/accounts/account.service.js';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { KeyedHasher } from '../src/otp/keyed-hash.js';
import { IDENTITY_KEY_PURPOSE, PHONE_FIELD, type VerifiedPhone } from '../src/otp/otp.service.js';
import { LocalAccessTokenSigner } from '../src/sessions/access-token.js';
import { DrizzleSessionStore } from '../src/sessions/session-store.js';
import { REFRESH_TOKEN_TTL_SECONDS, SessionService } from '../src/sessions/session.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

const logger = createLogger({ service: 'identity-test', destination: { write: () => undefined } });
const DEVICE = 'device-a';

function setup(clock = { now: new Date() }) {
  const orm = drizzle(db.pool);
  const keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new DrizzleAccountKeyStore(orm),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });
  const accountStore = new DrizzleAccountStore(orm);
  const hasher = new KeyedHasher(randomBytes(32));
  const sessions = new SessionService({
    sessions: new DrizzleSessionStore(orm),
    signer: new LocalAccessTokenSigner(),
    deviceHasher: hasher,
    accountStatus: async (id) => (await accountStore.get(id))?.status,
    allowedStatuses: SIGN_IN_STATUSES,
    logger,
    now: () => clock.now,
  });
  const accounts = new AccountService({
    accounts: accountStore,
    keyring,
    hasActivationConsents: () => Promise.resolve(true),
    revokeAllSessions: (id, reason) => sessions.revokeAll(id, reason),
    logger,
    now: () => clock.now,
  });
  /** A phone that passed its code check, sealed under a fresh prospective id. */
  const verified = async (): Promise<VerifiedPhone> => {
    const id = crypto.randomUUID();
    const sealed = await keyring.encrypt(id, PHONE_FIELD, `+2782${String(Date.now()).slice(-7)}`);
    return {
      phoneLookup: randomBytes(32),
      prospectiveAccountId: id,
      phoneCiphertext: Buffer.from(sealed.ciphertext),
      phoneNonce: Buffer.from(sealed.nonce),
    };
  };
  return { accounts, sessions, verified, clock };
}

async function rejectedWith(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

async function signedIn(s: ReturnType<typeof setup>) {
  const { account } = await s.accounts.signIn(await s.verified());
  return { accountId: account.id, tokens: await s.sessions.open(account.id, DEVICE) };
}

const revokeReason = async (accountId: string): Promise<string[]> => {
  const { rows } = await db.pool.query<{ revoke_reason: string | null }>(
    'select revoke_reason from identity.sessions where account_id = $1 order by created_at',
    [accountId],
  );
  return rows.map((r) => r.revoke_reason ?? 'active');
};

describe('refresh-token rotation (M1.1: token rotation and revocation tested)', () => {
  it('issues a new pair on every refresh, and the old refresh token stops working', async () => {
    const s = setup();
    const { tokens } = await signedIn(s);
    const next = await s.sessions.refresh(tokens.refreshToken, DEVICE);
    expect(next.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.tokens.accessToken).not.toBe(tokens.accessToken);
    await expect(s.sessions.refresh(next.tokens.refreshToken, DEVICE)).resolves.toBeDefined();
  });

  it('treats reuse of an exchanged token as theft and ends the whole session', async () => {
    const s = setup();
    const { accountId, tokens } = await signedIn(s);
    const next = await s.sessions.refresh(tokens.refreshToken, DEVICE);
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, DEVICE), 'unauthenticated');
    // The member's newer token dies too, so a thief holding either copy is locked out.
    await rejectedWith(s.sessions.refresh(next.tokens.refreshToken, DEVICE), 'unauthenticated');
    expect(await revokeReason(accountId)).toEqual(['refresh_reuse']);
  });

  it('lets only one of several parallel refreshes with the same token through', async () => {
    const s = setup();
    const { tokens } = await signedIn(s);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => s.sessions.refresh(tokens.refreshToken, DEVICE)),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
  });

  it('ends the session when a refresh token is used from another device', async () => {
    const s = setup();
    const { accountId, tokens } = await signedIn(s);
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, 'device-b'), 'unauthenticated');
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, DEVICE), 'unauthenticated');
    expect(await revokeReason(accountId)).toEqual(['device_mismatch']);
  });

  it('refuses a refresh token after 30 days', async () => {
    const clock = { now: new Date() };
    const s = setup(clock);
    const { tokens } = await signedIn(s);
    clock.now = new Date(clock.now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, DEVICE), 'unauthenticated');
  });

  it('refuses malformed and unknown tokens with the same answer', async () => {
    const s = setup();
    for (const token of ['', 'short', randomBytes(32).toString('base64url')]) {
      await rejectedWith(s.sessions.refresh(token, DEVICE), 'unauthenticated');
    }
  });

  it('stores refresh tokens only as hashes', async () => {
    const s = setup();
    const { tokens } = await signedIn(s);
    const { rows } = await db.pool.query<{ t: string }>(
      `select string_agg(encode(token_hash, 'escape'), '') as t from identity.refresh_tokens`,
    );
    expect(rows[0]?.t ?? '').not.toContain(tokens.refreshToken);
  });
});

describe('revocation', () => {
  it('signs out of one session without touching the others', async () => {
    const s = setup();
    const { accountId, tokens } = await signedIn(s);
    const other = await s.sessions.open(accountId, 'device-b');
    const claims = JSON.parse(
      Buffer.from(tokens.accessToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as { sid: string };
    await s.sessions.revoke(claims.sid, accountId);
    await s.sessions.revoke(claims.sid, accountId); // idempotent
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, DEVICE), 'unauthenticated');
    await expect(s.sessions.refresh(other.refreshToken, 'device-b')).resolves.toBeDefined();
  });

  it('does not let one account end another account’s session', async () => {
    const s = setup();
    const victim = await signedIn(s);
    const attacker = await signedIn(s);
    const sid = (
      JSON.parse(
        Buffer.from(victim.tokens.accessToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as { sid: string }
    ).sid;
    await s.sessions.revoke(sid, attacker.accountId);
    await expect(s.sessions.refresh(victim.tokens.refreshToken, DEVICE)).resolves.toBeDefined();
  });

  it('signs out everywhere', async () => {
    const s = setup();
    const { accountId, tokens } = await signedIn(s);
    const other = await s.sessions.open(accountId, 'device-b');
    await s.sessions.revokeAll(accountId);
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, DEVICE), 'unauthenticated');
    await rejectedWith(s.sessions.refresh(other.refreshToken, 'device-b'), 'unauthenticated');
  });
});

describe('accounts on PostgreSQL', () => {
  it('ends every session and blocks refresh when the member is under 18', async () => {
    const s = setup();
    const { accountId, tokens } = await signedIn(s);
    const today = new Date();
    await s.accounts.setDateOfBirth(accountId, {
      year: today.getUTCFullYear() - 10,
      month: 1,
      day: 1,
    });
    await rejectedWith(s.sessions.refresh(tokens.refreshToken, DEVICE), 'unauthenticated');
    const { rows } = await db.pool.query<{
      status: string;
      date_of_birth: string | null;
      keys: string;
    }>(
      `select status, date_of_birth,
              (select count(*) from identity.account_keys where subject_id = $1)::text as keys
         from identity.accounts where id = $1`,
      [accountId],
    );
    expect(rows[0]).toEqual({ status: 'ineligible', date_of_birth: null, keys: '0' });
  });

  it('creates one account when two sign-ins for a new number race', async () => {
    const s = setup();
    const first = await s.verified();
    const second = { ...(await s.verified()), phoneLookup: first.phoneLookup };
    const results = await Promise.all([s.accounts.signIn(first), s.accounts.signIn(second)]);
    expect(new Set(results.map((r) => r.account.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });
});
