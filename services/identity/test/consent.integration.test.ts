import { randomBytes, randomUUID } from 'node:crypto';
import { createEvent } from '@chronos/contracts/events';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountStore } from '../src/accounts/account-store.js';
import { DrizzleConsentStore } from '../src/consent/consent-store.js';
import { type VaultEraser, VaultErasureRelay } from '../src/consent/vault-erasure-relay.js';
import { runMigrations } from '../src/db/migrate.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;
const logger = createLogger({ service: 'identity-test', destination: { write: () => undefined } });

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

const orm = () => drizzle(db.pool);

async function newAccount(): Promise<string> {
  const id = randomUUID();
  await new DrizzleAccountStore(orm()).insertPending(
    {
      id,
      phoneLookup: randomBytes(32),
      phoneCiphertext: randomBytes(40),
      phoneNonce: randomBytes(12),
    },
    [],
  );
  return id;
}

const entry = (
  type: 'terms' | 'privacy' | 'health_processing' | 'marketing',
  granted: boolean,
  at: number,
) => ({
  type,
  policyVersion: `${type}-v1`,
  granted,
  recordedAt: new Date(at),
});

describe('consent records on PostgreSQL', () => {
  it('returns the history in order and the latest entry per type', async () => {
    const store = new DrizzleConsentStore(orm());
    const accountId = await newAccount();
    const t = Date.now();
    await store.record(randomUUID(), accountId, entry('terms', true, t), {});
    await store.record(randomUUID(), accountId, entry('marketing', true, t + 1000), {});
    await store.record(randomUUID(), accountId, entry('marketing', false, t + 2000), {});
    expect((await store.history(accountId)).map((h) => [h.type, h.granted])).toEqual([
      ['terms', true],
      ['marketing', true],
      ['marketing', false],
    ]);
    const latest = await store.latest(accountId);
    expect(latest.marketing?.granted).toBe(false);
    expect(latest.terms?.granted).toBe(true);
    expect(latest.privacy).toBeUndefined();
  });

  it('refuses any update: the history is append-only', async () => {
    const store = new DrizzleConsentStore(orm());
    const accountId = await newAccount();
    await store.record(randomUUID(), accountId, entry('terms', false, Date.now()), {});
    await expect(
      db.pool.query('update identity.consent_records set granted = true where account_id = $1', [
        accountId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('deletes the history with the account (erasure)', async () => {
    const store = new DrizzleConsentStore(orm());
    const accountId = await newAccount();
    await store.record(randomUUID(), accountId, entry('terms', true, Date.now()), {});
    await db.pool.query('delete from identity.accounts where id = $1', [accountId]);
    expect(await store.history(accountId)).toEqual([]);
  });

  it('writes a health erasure request in the same transaction as the withdrawal', async () => {
    const store = new DrizzleConsentStore(orm());
    const accountId = await newAccount();
    const requestId = randomUUID();
    await store.record(randomUUID(), accountId, entry('health_processing', false, Date.now()), {
      vaultErasureRequestId: requestId,
    });
    const { rows } = await db.pool.query<{ account_id: string }>(
      'select account_id from identity.vault_erasure_requests where id = $1',
      [requestId],
    );
    expect(rows).toEqual([{ account_id: accountId }]);
  });

  it('marks the account pending erasure and queues account.erasure_requested atomically', async () => {
    const store = new DrizzleConsentStore(orm());
    const accountId = await newAccount();
    const event = createEvent('account.erasure_requested', 'identity', {
      accountId,
      requestedAt: new Date().toISOString(),
    });
    const vaultRequestId = randomUUID();
    await store.record(randomUUID(), accountId, entry('terms', false, Date.now()), {
      startAccountErasure: { vaultRequestId, events: [event] },
    });
    const { rows } = await db.pool.query(
      `select status, phone_lookup is null as number_freed, erasure_requested_at is not null as timed,
              (select count(*) from identity.outbox where id = $2)::int as events,
              (select count(*) from identity.vault_erasure_requests where id = $3)::int as vault
         from identity.accounts where id = $1`,
      [accountId, event.eventId, vaultRequestId],
    );
    // ADR-0025: the number can open a new account at once; health erasure is queued.
    expect(rows[0]).toEqual({
      status: 'pending_erasure',
      number_freed: true,
      timed: true,
      events: 1,
      vault: 1,
    });
  });

  it('writes nothing at all when part of the transaction fails', async () => {
    const store = new DrizzleConsentStore(orm());
    const accountId = await newAccount();
    const requestId = randomUUID();
    await db.pool.query(
      'insert into identity.vault_erasure_requests (id, account_id) values ($1, $2)',
      [requestId, accountId],
    );
    await expect(
      store.record(randomUUID(), accountId, entry('health_processing', false, Date.now()), {
        vaultErasureRequestId: requestId, // duplicate key: the whole write must roll back
      }),
    ).rejects.toThrow();
    expect(await store.history(accountId)).toEqual([]);
  });
});

describe('vault erasure relay', () => {
  class FakeVault implements VaultEraser {
    readonly calls: { accountId: string; requestId: string }[] = [];
    failing = false;
    delayMs = 0;
    async eraseSubject(accountId: string, requestId: string): Promise<void> {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (this.failing) throw new Error('vault unavailable');
      this.calls.push({ accountId, requestId });
    }
  }

  async function queue(n: number): Promise<string[]> {
    await db.pool.query('delete from identity.vault_erasure_requests');
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = randomUUID();
      await db.pool.query(
        'insert into identity.vault_erasure_requests (id, account_id) values ($1, $2)',
        [id, randomUUID()],
      );
      ids.push(id);
    }
    return ids;
  }

  it('delivers each request with its idempotency key and marks it done', async () => {
    const [id] = await queue(1);
    const vault = new FakeVault();
    const relay = new VaultErasureRelay({ db: orm(), eraser: vault, logger });
    expect(await relay.runOnce()).toBe(1);
    expect(await relay.runOnce()).toBe(0);
    expect(vault.calls.map((c) => c.requestId)).toEqual([id]);
  });

  it('keeps retrying, with backoff, until the vault confirms', async () => {
    await queue(1);
    const vault = new FakeVault();
    vault.failing = true;
    let now = new Date();
    const relay = new VaultErasureRelay({ db: orm(), eraser: vault, logger, now: () => now });
    expect(await relay.runOnce()).toBe(0);
    expect(await relay.runOnce()).toBe(0); // backing off
    vault.failing = false;
    now = new Date(now.getTime() + 60_000);
    expect(await relay.runOnce()).toBe(1);
    expect(vault.calls).toHaveLength(1);
  });

  it('never delivers one request twice when replicas run at once', async () => {
    await queue(10);
    const vault = new FakeVault();
    vault.delayMs = 5;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        new VaultErasureRelay({ db: orm(), eraser: vault, logger }).runOnce(),
      ),
    );
    const ids = vault.calls.map((c) => c.requestId);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toHaveLength(10);
  });
});
