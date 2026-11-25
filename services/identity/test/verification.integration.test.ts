import { randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountStore } from '../src/accounts/account-store.js';
import { DrizzleConsentStore } from '../src/consent/consent-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzleVerificationStore } from '../src/verification/verification-store.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

const orm = () => drizzle(db.pool);
const job = () => ({ ciphertext: randomBytes(40), nonce: randomBytes(12) });

async function newAccount(): Promise<string> {
  const id = randomUUID();
  const accounts = new DrizzleAccountStore(orm());
  await accounts.insertPending(
    {
      id,
      phoneLookup: randomBytes(32),
      phoneCiphertext: randomBytes(40),
      phoneNonce: randomBytes(12),
    },
    [],
  );
  await accounts.activateWithDateOfBirth(id, '1990-01-01');
  return id;
}

async function pending(store: DrizzleVerificationStore, accountId: string): Promise<string> {
  const id = randomUUID();
  await store.insertPending({ id, accountId, provider: 'fake', captureKey: `verification/${id}` });
  await store.accepted(id, job(), new Date(Date.now() - 1000));
  return id;
}

describe('verification attempts on PostgreSQL', () => {
  it('marks the account verified in the same transaction as a pass, and only once', async () => {
    const store = new DrizzleVerificationStore(orm());
    const accounts = new DrizzleAccountStore(orm());
    const accountId = await newAccount();
    const id = await pending(store, accountId);

    expect((await store.dueChecks(new Date(), 10)).map((d) => d.id)).toContain(id);
    expect(await store.decide(id, 'passed', null, new Date())).toBe(true);
    expect(await store.decide(id, 'failed', 'poor_quality', new Date())).toBe(false);
    expect((await accounts.get(accountId))?.verified).toBe(true);
    expect(await store.recent(accountId)).toMatchObject([{ id, outcome: 'passed', failure: null }]);
  });

  it('keeps a failure reason only for failed attempts and allows one review request', async () => {
    const store = new DrizzleVerificationStore(orm());
    const accountId = await newAccount();
    const id = await pending(store, accountId);
    await store.decide(id, 'failed', 'not_confirmed', new Date());
    expect(await store.requestReview(id, new Date())).toBe(true);
    expect(await store.requestReview(id, new Date())).toBe(false);
    expect(await store.recent(accountId)).toMatchObject([
      { outcome: 'failed', failure: 'not_confirmed', reviewRequested: true, hasCapture: true },
    ]);
  });

  it('selects captures for deletion after the cutoff or on request, never while a check runs', async () => {
    const store = new DrizzleVerificationStore(orm());
    const accountId = await newAccount();
    const running = await pending(store, accountId);
    const decided = randomUUID();
    await store.insertPending({
      id: decided,
      accountId,
      provider: 'fake',
      captureKey: `verification/${decided}`,
    });
    await store.decide(decided, 'failed', 'poor_quality', new Date());

    const future = new Date(Date.now() + 60_000);
    const due = (await store.duePurges(future, new Date(), 100)).map((d) => d.id);
    expect(due).toContain(decided);
    expect(due).not.toContain(running);

    await store.purged(decided);
    expect((await store.duePurges(future, new Date(), 100)).map((d) => d.id)).not.toContain(
      decided,
    );
    expect((await store.recent(accountId)).find((a) => a.id === decided)?.hasCapture).toBe(false);
  });

  it('forgets an account: ends the running check, schedules every copy and clears the badge', async () => {
    const store = new DrizzleVerificationStore(orm());
    const accounts = new DrizzleAccountStore(orm());
    const accountId = await newAccount();
    const passed = await pending(store, accountId);
    await store.decide(passed, 'passed', null, new Date());
    const running = await pending(store, accountId);

    await store.forgetAccount(accountId, new Date());
    expect((await accounts.get(accountId))?.verified).toBe(false);
    const past = new Date(0);
    const due = (await store.duePurges(past, new Date(), 100)).map((d) => d.id);
    expect(due).toEqual(expect.arrayContaining([passed, running]));
    expect(await store.decide(running, 'passed', null, new Date())).toBe(false);
  });

  it('removes attempts with the account and accepts the new consent type', async () => {
    const store = new DrizzleVerificationStore(orm());
    const accountId = await newAccount();
    await pending(store, accountId);
    await new DrizzleConsentStore(orm()).record(
      randomUUID(),
      accountId,
      {
        type: 'biometric_verification',
        policyVersion: 'v1',
        granted: true,
        recordedAt: new Date(),
      },
      {},
    );
    await db.pool.query('delete from identity.accounts where id = $1', [accountId]);
    expect(await store.recent(accountId)).toEqual([]);
  });
});
