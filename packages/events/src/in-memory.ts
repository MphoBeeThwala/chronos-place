import { parseEvent, type Topic } from '@chronos/contracts/events';
import type { EventHandler, EventPublisher, EventSubscriber } from './types.js';

/**
 * Publisher and subscriber in one process, for tests and for running services together without
 * a broker. Events are validated against the contracts like the Kafka path, delivered in order,
 * and redelivered while a handler throws (up to `maxAttempts`).
 */
export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  readonly published: { topic: string; key: string; event: unknown }[] = [];
  /** Handler errors that outlasted every attempt. */
  readonly failures: unknown[] = [];
  readonly #handlers = new Map<string, EventHandler<Topic>[]>();
  readonly #maxAttempts: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { maxAttempts?: number } = {}) {
    this.#maxAttempts = options.maxAttempts ?? 5;
  }

  async publish(topic: string, key: string, event: unknown): Promise<void> {
    const parsed = parseEvent(topic as Topic, event);
    this.published.push({ topic, key, event: parsed });
    const handlers = this.#handlers.get(topic) ?? [];
    this.#queue = this.#queue
      .then(async () => {
        for (const handler of handlers) await this.#deliver(handler, parsed);
      })
      .catch((err: unknown) => {
        this.failures.push(err);
      });
    await Promise.resolve();
  }

  subscribe<T extends Topic>(topic: T, handler: EventHandler<T>): void {
    const list = this.#handlers.get(topic) ?? [];
    list.push(handler);
    this.#handlers.set(topic, list);
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  /** Resolves once every published event has been handled. */
  drain(): Promise<void> {
    return this.#queue;
  }

  async close(): Promise<void> {
    await this.drain();
  }

  async #deliver(handler: EventHandler<Topic>, event: Parameters<EventHandler<Topic>>[0]) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await handler(event);
        return;
      } catch (err) {
        if (attempt >= this.#maxAttempts) throw err;
      }
    }
  }
}
