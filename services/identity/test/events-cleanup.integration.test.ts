import { randomBytes, randomUUID } from 'node:crypto';
import { createEvent, parseEvent } from '@chronos/contracts/events';
import { KeyDestroyedError, SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAccountStore } from '../src/accounts/account-store.js';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { type EventPublisher, OutboxRelay } from '../src/events/outbox.js';
import {
  CHALLENGE_GRACE_MS,
  IdentityCleanup,
  REVOKED_SESSION_RETENTION_MS,
} from '../src/maintenance/cleanup.js';
import { IDENTITY_KEY_PURPOSE, PHONE_FIELD } from '../src/otp/otp.service.js';
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

beforeEach(async () => {
  await db.pool.query('delete from identity.outbox');
});

const orm = () => drizzle(db.pool);
const keyring = () =>
  new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new DrizzleAccountKeyStore(orm()),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });

const newAccount = (lookup = randomBytes(32)) => ({
  id: randomUUID(),
  phoneLookup: lookup,
  phoneCiphertext: randomBytes(40),
  phoneNonce: randomBytes(12),
});
const createdEvent = (accountId: string) =>
  createEvent('account.created', 'identity', { accountId, createdAt: new Date().toISOString() });

class RecordingPublisher implements EventPublisher {
  readonly sent: { topic: string; key: string; event: unknown }[] = [];
  failFor = new Set<string>();
  delayMs = 0;

  async publish(topic: string, key: string, event: unknown): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const id = (event as { eventId: string }).eventId;
    if (this.failFor.has(id)) throw new Error('broker unavailable');
    this.sent.push({ topic, key, event });
  }
}

describe('transactional outbox', () => {
  it('writes account.created in the same transaction as the account', async () => {
    const store = new DrizzleAccountStore(orm());
    const account = newAccount();
    expect(await store.insertPending(account, [createdEvent(account.id)])).toBe(true);
    const { rows } = await db.pool.query<{
      topic: string;
      partition_key: string;
      payload: unknown;
    }>('select topic, partition_key, payload from identity.outbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe('account.created');
    expect(rows[0]?.partition_key).toBe(account.id);
    expect(parseEvent('account.created', rows[0]?.payload).data.accountId).toBe(account.id);
  });

  it('writes no event when the account insert loses a race', async () => {
    const store = new DrizzleAccountStore(orm());
    const lookup = randomBytes(32);
    const first = newAccount(lookup);
    const second = newAccount(lookup);
    await store.insertPending(first, [createdEvent(first.id)]);
    expect(await store.insertPending(second, [createdEvent(second.id)])).toBe(false);
    const { rows } = await db.pool.query('select 1 from identity.outbox');
    expect(rows).toHaveLength(1);
  });
});

describe('outbox relay', () => {
  async function seed(n: number): Promise<string[]> {
    const store = new DrizzleAccountStore(orm());
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const account = newAccount();
      const event = createdEvent(account.id);
      await store.insertPending(account, [event]);
      ids.push(event.eventId);
    }
    return ids;
  }

  it('publishes in creation order, keyed by account, exactly once', async () => {
    const ids = await seed(3);
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay({ db: orm(), publisher, logger });
    expect(await relay.runOnce()).toBe(3);
    expect(await relay.runOnce()).toBe(0);
    expect(publisher.sent.map((s) => (s.event as { eventId: string }).eventId)).toEqual(ids);
    for (const s of publisher.sent) {
      expect(s.key).toBe((s.event as { data: { accountId: string } }).data.accountId);
    }
  });

  it('retries a failed event later without holding up the others', async () => {
    const [failing, ok] = await seed(2);
    const publisher = new RecordingPublisher();
    publisher.failFor.add(failing ?? '');
    let now = new Date();
    const relay = new OutboxRelay({ db: orm(), publisher, logger, now: () => now });
    expect(await relay.runOnce()).toBe(1);
    expect(publisher.sent.map((s) => (s.event as { eventId: string }).eventId)).toEqual([ok]);
    expect(await relay.runOnce()).toBe(0); // backing off
    publisher.failFor.clear();
    now = new Date(now.getTime() + 5000);
    expect(await relay.runOnce()).toBe(1);
    const { rows } = await db.pool.query<{ attempts: number }>(
      'select attempts from identity.outbox where id = $1',
      [failing],
    );
    expect(rows[0]?.attempts).toBe(1);
  });

  it('never sends one event twice when replicas run the relay at the same time', async () => {
    await seed(20);
    const publisher = new RecordingPublisher();
    publisher.delayMs = 5;
    const relays = Array.from(
      { length: 4 },
      () => new OutboxRelay({ db: orm(), publisher, logger }),
    );
    await Promise.all(relays.map((r) => r.runOnce()));
    const ids = publisher.sent.map((s) => (s.event as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
  });
});

describe('cleanup', () => {
  async function challenge(prospectiveAccountId: string, expiresAt: Date): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `insert into identity.otp_challenges
         (id, phone_lookup, prospective_account_id, phone_ciphertext, phone_nonce, code_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        randomBytes(32),
        prospectiveAccountId,
        randomBytes(40),
        randomBytes(12),
        randomBytes(32),
        expiresAt,
      ],
    );
    return id;
  }
  const exists = async (table: string, id: string): Promise<boolean> =>
    (await db.pool.query(`select 1 from identity.${table} where id = $1`, [id])).rows.length === 1;

  it('shreds the sealed number of a challenge that never became an account, then deletes it', async () => {
    const ring = keyring();
    const prospective = randomUUID();
    const sealed = await ring.encrypt(prospective, PHONE_FIELD, '+27820009999');
    const id = await challenge(prospective, new Date(Date.now() - CHALLENGE_GRACE_MS - 1000));
    const result = await new IdentityCleanup({ db: orm(), keyring: ring, logger }).runOnce();
    expect(result.keysShredded).toBeGreaterThanOrEqual(1);
    expect(await exists('otp_challenges', id)).toBe(false);
    await expect(ring.decrypt(prospective, PHONE_FIELD, sealed)).rejects.toBeInstanceOf(
      KeyDestroyedError,
    );
  });

  it('keeps the key when the challenge created the account', async () => {
    const ring = keyring();
    const account = newAccount();
    const sealed = await ring.encrypt(account.id, PHONE_FIELD, '+27820009998');
    await new DrizzleAccountStore(orm()).insertPending(account, []);
    const id = await challenge(account.id, new Date(Date.now() - CHALLENGE_GRACE_MS - 1000));
    await new IdentityCleanup({ db: orm(), keyring: ring, logger }).runOnce();
    expect(await exists('otp_challenges', id)).toBe(false);
    await expect(ring.decrypt(account.id, PHONE_FIELD, sealed)).resolves.toBe('+27820009998');
  });

  it('leaves challenges inside the grace period alone', async () => {
    const id = await challenge(randomUUID(), new Date(Date.now() - 60_000));
    await new IdentityCleanup({ db: orm(), keyring: keyring(), logger }).runOnce();
    expect(await exists('otp_challenges', id)).toBe(true);
  });

  it('deletes long-expired and long-revoked sessions, and old published events', async () => {
    const account = newAccount();
    await new DrizzleAccountStore(orm()).insertPending(account, []);
    const session = async (expiresAt: Date, revokedAt: Date | null) => {
      const id = randomUUID();
      await db.pool.query(
        `insert into identity.sessions (id, account_id, device_hash, expires_at, revoked_at)
         values ($1, $2, $3, $4, $5)`,
        [id, account.id, randomBytes(32), expiresAt, revokedAt],
      );
      return id;
    };
    const day = 24 * 60 * 60 * 1000;
    const live = await session(new Date(Date.now() + day), null);
    const expired = await session(new Date(Date.now() - 2 * day), null);
    const recentlyRevoked = await session(new Date(Date.now() + day), new Date(Date.now() - day));
    const longRevoked = await session(
      new Date(Date.now() + day),
      new Date(Date.now() - REVOKED_SESSION_RETENTION_MS - day),
    );
    const oldEvent = createdEvent(account.id);
    const pendingEvent = createdEvent(account.id);
    await db.pool.query(
      `insert into identity.outbox (id, topic, partition_key, payload, published_at) values
         ($1, 'account.created', $3, $4, now() - interval '8 days'),
         ($2, 'account.created', $3, $5, null)`,
      [oldEvent.eventId, pendingEvent.eventId, account.id, oldEvent, pendingEvent],
    );
    await new IdentityCleanup({ db: orm(), keyring: keyring(), logger }).runOnce();
    expect(await exists('sessions', live)).toBe(true);
    expect(await exists('sessions', recentlyRevoked)).toBe(true);
    expect(await exists('sessions', expired)).toBe(false);
    expect(await exists('sessions', longRevoked)).toBe(false);
    expect(await exists('outbox', oldEvent.eventId)).toBe(false);
    expect(await exists('outbox', pendingEvent.eventId)).toBe(true);
  });
});
