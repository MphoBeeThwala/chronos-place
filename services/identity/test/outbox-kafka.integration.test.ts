import { randomBytes, randomUUID } from 'node:crypto';
import { createEvent, TOPICS } from '@chronos/contracts/events';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper, InMemoryWrappedKeyStore } from '@chronos/crypto/testing';
import { ensureTopics, KafkaEventPublisher, KafkaEventSubscriber } from '@chronos/events';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountStore } from '../src/accounts/account-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzleErasureStore } from '../src/erasure/erasure-store.js';
import { ErasureService } from '../src/erasure/erasure.service.js';
import { OutboxRelay } from '../src/events/outbox.js';
import { startTestBroker } from './support/broker.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;
let brokers: string[];
let stopBroker: () => Promise<void>;
const logger = createLogger({ service: 'identity-test', destination: { write: () => undefined } });

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  ({ brokers, stop: stopBroker } = await startTestBroker());
  await ensureTopics({ brokers, clientId: 'identity-test-admin' }, TOPICS);
});

afterAll(async () => {
  await db.stop();
  await stopBroker();
});

describe('outbox to Kafka (ADR-0019)', () => {
  it('publishes account.created from the outbox, and marks it published once', async () => {
    const account = {
      id: randomUUID(),
      phoneLookup: randomBytes(32),
      phoneCiphertext: randomBytes(40),
      phoneNonce: randomBytes(12),
    };
    const event = createEvent('account.created', 'identity', {
      accountId: account.id,
      createdAt: new Date().toISOString(),
    });
    await new DrizzleAccountStore(drizzle(db.pool)).insertPending(account, [event]);

    const received: string[] = [];
    const subscriber = new KafkaEventSubscriber({ brokers, clientId: `t-${randomUUID()}`, logger });
    subscriber.subscribe('account.created', (e) => {
      if (e.data.accountId === account.id) received.push(e.eventId);
      return Promise.resolve();
    });
    await subscriber.start();

    const publisher = new KafkaEventPublisher({ brokers, clientId: 'identity', logger });
    const relay = new OutboxRelay({ db: drizzle(db.pool), publisher, logger });
    expect(await relay.runOnce()).toBe(1);
    expect(await relay.runOnce()).toBe(0);

    const end = Date.now() + 20_000;
    while (received.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([event.eventId]);
    const { rows } = await db.pool.query<{ published: boolean }>(
      'select published_at is not null as published from identity.outbox where id = $1',
      [event.eventId],
    );
    expect(rows[0]?.published).toBe(true);

    await subscriber.close();
    await publisher.close();
  });

  it('records a service\u2019s erasure confirmation that arrives over Kafka', async () => {
    const accountId = randomUUID();
    await db.pool.query(
      "insert into identity.accounts (id, status, erasure_requested_at) values ($1, 'pending_erasure', now())",
      [accountId],
    );
    const erasure = new ErasureService({
      store: new DrizzleErasureStore(drizzle(db.pool)),
      keyring: new SubjectKeyring({
        wrapper: new InMemoryKeyWrapper(),
        store: new InMemoryWrappedKeyStore(),
        purpose: 'identity-test',
      }),
      services: ['profile'],
      forgetVerification: () => Promise.resolve(),
      logger,
    });
    const subscriber = new KafkaEventSubscriber({ brokers, clientId: `t-${randomUUID()}`, logger });
    subscriber.subscribe('account.erasure_confirmed', (e) => erasure.confirmed(e));
    await subscriber.start();

    const publisher = new KafkaEventPublisher({ brokers, clientId: 'profile', logger });
    const event = createEvent('account.erasure_confirmed', 'profile', {
      accountId,
      service: 'profile',
    });
    await publisher.publish(event.type, accountId, event);

    const count = async () =>
      (
        await db.pool.query<{ n: number }>(
          'select count(*)::int as n from identity.erasure_confirmations where account_id = $1',
          [accountId],
        )
      ).rows[0]?.n;
    const end = Date.now() + 20_000;
    while ((await count()) === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(await count()).toBe(1);
    expect(await erasure.runOnce()).toBe(1);

    await subscriber.close();
    await publisher.close();
  });
});
