import { ContractError, parseEvent, type Topic } from '@chronos/contracts/events';
import type { Logger } from '@chronos/logger';
import {
  Admin,
  Consumer,
  type Message,
  type MessagesStream,
  ProduceAcks,
  Producer,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';
import type { EventHandler, EventPublisher, EventSubscriber } from './types.js';

export interface KafkaOptions {
  /** host:port list. Locally Redpanda at 127.0.0.1:19092. */
  brokers: string[];
  /** The service's name: client id, and the consumer group. */
  clientId: string;
  logger: Logger;
}

/**
 * Idempotent producer with acks from every in-sync replica (ADR-0019), keyed so one member's
 * events stay in order. Values are the JSON event as built by @chronos/contracts.
 */
export class KafkaEventPublisher implements EventPublisher {
  readonly #producer: Producer<string, string, string, string>;

  constructor(options: KafkaOptions) {
    this.#producer = new Producer({
      clientId: options.clientId,
      bootstrapBrokers: options.brokers,
      serializers: stringSerializers,
      idempotent: true,
      acks: ProduceAcks.ALL,
    });
  }

  async publish(topic: string, key: string, event: unknown): Promise<void> {
    await this.#producer.send({ messages: [{ topic, key, value: JSON.stringify(event) }] });
  }

  close(): Promise<void> {
    return this.#producer.close();
  }
}

/** Retry waits for a failing handler grow 2^n × 250 ms, capped at 30 seconds. */
export const MAX_RETRY_MS = 30_000;

/**
 * Consumes as the service's consumer group, from the last committed offset (the earliest offset
 * the first time). Each message is validated against the contracts before any handler sees it.
 * An offset is committed only after its handlers succeed; a failing handler is retried in place,
 * so later events for the same partition wait rather than overtake it.
 */
export class KafkaEventSubscriber implements EventSubscriber {
  readonly #options: KafkaOptions;
  readonly #handlers = new Map<string, EventHandler<Topic>[]>();
  readonly #consumer: Consumer<string, string, string, string>;
  readonly #sleep: (ms: number) => Promise<void>;
  #stream: MessagesStream<string, string, string, string> | undefined;
  #closing = false;
  #running: Promise<void> | undefined;

  constructor(options: KafkaOptions & { sleep?: (ms: number) => Promise<void> }) {
    this.#options = options;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#consumer = new Consumer({
      clientId: options.clientId,
      groupId: options.clientId,
      bootstrapBrokers: options.brokers,
      deserializers: stringDeserializers,
    });
  }

  subscribe<T extends Topic>(topic: T, handler: EventHandler<T>): void {
    if (this.#stream) throw new Error('subscribe before start');
    const list = this.#handlers.get(topic) ?? [];
    list.push(handler);
    this.#handlers.set(topic, list);
  }

  async start(): Promise<void> {
    const stream = await this.#consumer.consume({
      topics: [...this.#handlers.keys()],
      autocommit: false,
      mode: 'committed',
      fallbackMode: 'earliest',
    });
    this.#stream = stream;
    this.#running = (async () => {
      for await (const message of stream) {
        if (this.#closing) break;
        await this.#handle(message);
      }
    })();
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#stream?.close();
    await this.#running?.catch(() => undefined);
    await this.#consumer.close(true);
  }

  async #handle(message: Message<string, string, string, string>) {
    const { logger } = this.#options;
    const topic = message.topic as Topic;
    let event;
    try {
      event = parseEvent(topic, JSON.parse(message.value));
    } catch (err) {
      // Never log the payload: a malformed event could still hold personal data.
      const reason = err instanceof ContractError ? 'contract' : 'json';
      logger.error({ topic, partition: message.partition, reason }, 'invalid event skipped');
      await message.commit();
      return;
    }
    for (const handler of this.#handlers.get(topic) ?? []) {
      for (let attempt = 0; !this.#closing; attempt += 1) {
        try {
          await handler(event);
          break;
        } catch (err) {
          logger.error({ err, topic, eventId: event.eventId, attempt }, 'event handler failed');
          await this.#sleep(Math.min(250 * 2 ** attempt, MAX_RETRY_MS));
        }
      }
    }
    if (!this.#closing) await message.commit();
  }
}

/**
 * Creates any missing topics. For local development and tests: deployed topics are made by
 * infrastructure code with their own partition and retention settings.
 */
export async function ensureTopics(
  options: Omit<KafkaOptions, 'logger'>,
  topics: readonly string[],
  partitions = 3,
): Promise<void> {
  const admin = new Admin({ clientId: options.clientId, bootstrapBrokers: options.brokers });
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((t) => !existing.has(t));
    if (missing.length > 0) await admin.createTopics({ topics: missing, partitions, replicas: 1 });
  } finally {
    await admin.close();
  }
}
