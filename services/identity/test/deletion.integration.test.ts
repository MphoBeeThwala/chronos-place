import { randomUUID } from 'node:crypto';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAccountStore } from '../src/accounts/account-store.js';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzleDeletionStore } from '../src/deletion/deletion-store.js';
import { DeletionService } from '../src/deletion/deletion.service.js';
import { DrizzleChallengeStore } from '../src/otp/challenge-store.js';
import { CodeHasher } from '../src/otp/code.js';
import { KeyedHasher } from '../src/otp/keyed-hash.js';
import { OTP_LIMITS } from '../src/otp/limits.js';
import { IDENTITY_KEY_PURPOSE, OtpService, PHONE_FIELD } from '../src/otp/otp.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import {
  client,
  FakeClock,
  InMemoryRateLimitStore,
  RecordingOtpSender,
  syntheticPhone,
} from './support/otp-fakes.js';

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
let limits: InMemoryRateLimitStore;
let sender: RecordingOtpSender;
let revoked: { accountId: string; reason: string }[];
const lookupHasher = new KeyedHasher(Buffer.alloc(32, 1));
const codeHasher = new CodeHasher(Buffer.alloc(32, 2));
let keyring: SubjectKeyring;
let deletion: DeletionService;
let phoneN = 100;

beforeEach(() => {
  clock = new FakeClock();
  limits = new InMemoryRateLimitStore(clock);
  sender = new RecordingOtpSender();
  revoked = [];
  logLines.length = 0;
  const orm = drizzle(db.pool);
  keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new DrizzleAccountKeyStore(orm),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });
  deletion = new DeletionService({
    store: new DrizzleDeletionStore(orm),
    limits,
    sender,
    keyring,
    lookupHasher,
    codeHasher,
    revokeAllSessions: (accountId, reason) => {
      revoked.push({ accountId, reason });
      return Promise.resolve();
    },
    logger,
    now: clock.now,
  });
});

/** An active account with a sealed synthetic number, as sign-in creates it. */
async function activeAccount(status = 'active') {
  phoneN += 1;
  const phone = syntheticPhone(phoneN);
  const id = randomUUID();
  const sealed = await keyring.encrypt(id, PHONE_FIELD, phone);
  const phoneLookup = lookupHasher.hash('phone', phone);
  await new DrizzleAccountStore(drizzle(db.pool)).insertPending(
    {
      id,
      phoneLookup,
      phoneCiphertext: Buffer.from(sealed.ciphertext),
      phoneNonce: Buffer.from(sealed.nonce),
    },
    [],
  );
  await db.pool.query('update identity.accounts set status = $2 where id = $1', [id, status]);
  return { id, phone, tag: phoneLookup.toString('hex') };
}

const row = async (id: string) =>
  (
    await db.pool.query(
      `select status, phone_lookup is null as number_freed, erasure_requested_at is not null as timed,
              (select count(*) from identity.vault_erasure_requests v where v.account_id = a.id)::int as vault,
              (select count(*) from identity.outbox o
                 where o.topic = 'account.erasure_requested' and o.partition_key = a.id::text)::int as events
         from identity.accounts a where id = $1`,
      [id],
    )
  ).rows[0] as Record<string, unknown>;

const code = async (p: Promise<unknown>) => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof DomainError ? err.code : err;
};

describe('account deletion (ADR-0025)', () => {
  it('texts a fresh code to the account’s own number, and the code starts erasure', async () => {
    const account = await activeAccount();
    const challenge = await deletion.requestCode(account.id, client(1));
    expect(sender.sent.map((s) => s.phone)).toEqual([account.phone]);

    await deletion.deleteAccount(account.id, challenge.challengeId, sender.lastCode());
    expect(await row(account.id)).toEqual({
      status: 'pending_erasure',
      number_freed: true,
      timed: true,
      vault: 1,
      events: 1,
    });
    expect(revoked).toEqual([{ accountId: account.id, reason: 'account_deleted' }]);
    // The number is free at once: signing in again finds no account, so a new one is made.
    const again = await new DrizzleAccountStore(drizzle(db.pool)).findByPhoneLookup(
      lookupHasher.hash('phone', account.phone),
    );
    expect(again).toBeUndefined();
  });

  it('does nothing more when asked again after deletion started', async () => {
    const account = await activeAccount();
    const challenge = await deletion.requestCode(account.id, client(1));
    await deletion.deleteAccount(account.id, challenge.challengeId, sender.lastCode());
    await deletion.deleteAccount(account.id, challenge.challengeId, sender.lastCode());
    expect(await row(account.id)).toMatchObject({ vault: 1, events: 1 });
    expect(await code(deletion.requestCode(account.id, client(1)))).toBe('failed_precondition');
  });

  it('never accepts a sign-in code, or another account’s deletion code', async () => {
    const account = await activeAccount();
    const otp = new OtpService({
      challenges: new DrizzleChallengeStore(drizzle(db.pool)),
      limits,
      sender,
      keyring,
      lookupHasher,
      codeHasher,
      logger,
      now: clock.now,
    });
    const signIn = await otp.requestOtp(account.phone, client(2));
    expect(
      await code(deletion.deleteAccount(account.id, signIn.challengeId, sender.lastCode())),
    ).toBe('unauthenticated');

    const other = await activeAccount();
    clock.advance(OTP_LIMITS.resendCooldownSeconds + 1);
    const theirs = await deletion.requestCode(other.id, client(3));
    expect(
      await code(deletion.deleteAccount(account.id, theirs.challengeId, sender.lastCode())),
    ).toBe('unauthenticated');
    expect(await row(account.id)).toMatchObject({ status: 'active', number_freed: false });
  });

  it('shares the sign-in limits: cooldown, and lockout after wrong codes', async () => {
    const account = await activeAccount();
    const challenge = await deletion.requestCode(account.id, client(1));
    // The resend cooldown is the number's, whichever kind of code started it.
    expect(limits.entries.has(`cooldown:${account.tag}`)).toBe(true);
    expect(await code(deletion.requestCode(account.id, client(1)))).toBe('resource_exhausted');

    const right = sender.lastCode();
    const wrong = right === '000000' ? '000001' : '000000';
    for (let i = 0; i < OTP_LIMITS.attemptsPerCode; i += 1) {
      expect(await code(deletion.deleteAccount(account.id, challenge.challengeId, wrong))).toBe(
        'unauthenticated',
      );
    }
    // Out of tries: even the right code is refused now.
    expect(await code(deletion.deleteAccount(account.id, challenge.challengeId, right))).toBe(
      'unauthenticated',
    );

    // A second code's wrong tries reach the number's lockout (10 failures)...
    clock.advance(OTP_LIMITS.resendCooldownSeconds + 1);
    const second = await deletion.requestCode(account.id, client(1));
    const right2 = sender.lastCode();
    const wrong2 = right2 === '000000' ? '000001' : '000000';
    for (let i = 0; i < OTP_LIMITS.lockout.failures - OTP_LIMITS.attemptsPerCode; i += 1) {
      await code(deletion.deleteAccount(account.id, second.challengeId, wrong2));
    }
    expect(limits.entries.has(`lock:${account.tag}`)).toBe(true);
    // ...which then blocks sign-in codes for the same number too.
    const otp = new OtpService({
      challenges: new DrizzleChallengeStore(drizzle(db.pool)),
      limits,
      sender,
      keyring,
      lookupHasher,
      codeHasher,
      logger,
      now: clock.now,
    });
    expect(await code(otp.requestOtp(account.phone, client(2)))).toBe('resource_exhausted');
    expect(await row(account.id)).toMatchObject({ status: 'active' });
  });

  it('expires codes like sign-in codes', async () => {
    const account = await activeAccount();
    const challenge = await deletion.requestCode(account.id, client(1));
    clock.advance(OTP_LIMITS.codeTtlSeconds + 1);
    expect(
      await code(deletion.deleteAccount(account.id, challenge.challengeId, sender.lastCode())),
    ).toBe('unauthenticated');
  });

  it('refuses accounts that cannot be deleted here', async () => {
    for (const status of ['ineligible', 'suspended']) {
      const account = await activeAccount(status);
      expect(await code(deletion.requestCode(account.id, client(1)))).toBe('failed_precondition');
    }
    expect(sender.sent).toEqual([]);
  });

  it('keeps the number and the code out of the logs', async () => {
    const account = await activeAccount();
    const challenge = await deletion.requestCode(account.id, client(1));
    await deletion.deleteAccount(account.id, challenge.challengeId, sender.lastCode());
    const logs = logLines.join('\n');
    expect(logs).toContain('account deletion started');
    expect(logs).not.toContain(account.phone);
    expect(logs).not.toContain(account.phone.slice(3));
    expect(logs).not.toContain(sender.lastCode());
  });
});
