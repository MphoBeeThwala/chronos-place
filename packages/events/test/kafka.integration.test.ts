import { randomUUID } from 'node:crypto';
import { createEvent, type EventOf, TOPICS } from '@chronos/contracts/events';
import { createLogger } from '@chronos/logger';
import { Producer, stringSerializers } from '@platformatic/kafka';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTopics, KafkaEventPublisher, KafkaEventSubscriber } from '../src/index.js';
import { startTestBroker } from './support/broker.js';

const TOPIC = 'account.erasure_requested';
const logger = createLogger({ service: 'events-test', destination: { write: () => undefined } });
let brokers: string[];
let stop: () => Promise<void>;
let publisher: KafkaEventPublisher;

beforeAll(async () => {
  ({ brokers, stop } = await startTestBroker());
  await ensureTopics({ brokers, clientId: 'events-test-admin' }, TOPICS);
  publisher = new KafkaEventPublisher({ brokers, clientId: 'events-test', logger });
});

afterAll(async () => {
  await publisher.close();
  await stop();
});

/** A synthetic erasure request for a fresh random account. */
const erasure = (accountId = randomUUID()) =>
  createEvent(TOPIC, 'identity', { accountId, requestedAt: new Date().toISOString() });

const send = (event: EventOf<typeof TOPIC>) =>
  publisher.publish(TOPIC, event.data.accountId, event);

/** A subscriber in its own consumer group, collecting this test's accounts only. */
function collector(group: string, accounts: Set<string>, onEvent?: (id: string) => Promise<void>) {
  const seen: string[] = [];
  const subscriber = new KafkaEventSubscriber({
    brokers,
    clientId: group,
    logger,
    sleep: () => new Promise((r) => setTimeout(r, 20)),
  });
  subscriber.subscribe(TOPIC, async (event) => {
    if (!accounts.has(event.data.accountId)) return;
    await onEvent?.(event.eventId);
    seen.push(event.eventId);
  });
  return { subscriber, seen };
}

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('Kafka events (ADR-0019)', () => {
  it('delivers validated events in order for one member', async () => {
    const account = randomUUID();
    const events = [erasure(account), erasure(account), erasure(account)];
    const { subscriber, seen } = collector(`g-order-${randomUUID()}`, new Set([account]));
    await subscriber.start();
    for (const e of events) await send(e);
    await until(() => seen.length === 3);
    expect(seen).toEqual(events.map((e) => e.eventId));
    await subscriber.close();
  });

  it('skips an event that breaks its contract without blocking the next one', async () => {
    const account = randomUUID();
    const raw = new Producer({
      clientId: 'raw',
      bootstrapBrokers: brokers,
      serializers: stringSerializers,
    });
    await raw.send({
      messages: [
        { topic: TOPIC, key: account, value: 'not json' },
        {
          topic: TOPIC,
          key: account,
          value: JSON.stringify({ type: TOPIC, data: { accountId: account } }),
        },
      ],
    });
    await raw.close();
    const good = erasure(account);
    await send(good);
    const { subscriber, seen } = collector(`g-invalid-${randomUUID()}`, new Set([account]));
    await subscriber.start();
    await until(() => seen.length === 1);
    expect(seen).toEqual([good.eventId]);
    await subscriber.close();
  });

  it('retries a failing handler in place, so later events wait their turn', async () => {
    const account = randomUUID();
    const [first, second] = [erasure(account), erasure(account)];
    let failures = 0;
    const { subscriber, seen } = collector(`g-retry-${randomUUID()}`, new Set([account]), (id) => {
      if (id === first.eventId && failures < 2) {
        failures += 1;
        return Promise.reject(new Error('synthetic failure'));
      }
      return Promise.resolve();
    });
    await subscriber.start();
    await send(first);
    await send(second);
    await until(() => seen.length === 2);
    expect(failures).toBe(2);
    expect(seen).toEqual([first.eventId, second.eventId]);
    await subscriber.close();
  });

  it('resumes after the last committed event when a service restarts', async () => {
    const account = randomUUID();
    const group = `g-resume-${randomUUID()}`;
    const accounts = new Set([account]);
    const before = erasure(account);
    const first = collector(group, accounts);
    await first.subscriber.start();
    await send(before);
    await until(() => first.seen.length === 1);
    await first.subscriber.close();

    const whileDown = erasure(account);
    await send(whileDown);
    const second = collector(group, accounts);
    await second.subscriber.start();
    await until(() => second.seen.length >= 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(second.seen).toEqual([whileDown.eventId]);
    await second.subscriber.close();
  });
});
