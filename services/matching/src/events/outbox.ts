import { type EventOf, partitionKey, type Topic } from '@chronos/contracts/events';
import type { Logger } from '@chronos/logger';
import { sql } from 'drizzle-orm';
import type { EventPublisher } from '@chronos/events';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outbox } from '../db/schema.js';

/** An event ready to be written to the outbox, built with createEvent from @chronos/contracts. */
export type OutboxEvent = EventOf<Topic>;

export const outboxValues = (event: OutboxEvent) => ({
  id: event.eventId,
  topic: event.type,
  partitionKey: partitionKey(event),
  payload: event,
});

/** Where the relay sends events: Kafka (ADR-0019), through @chronos/events. */
export type { EventPublisher } from '@chronos/events';

export const RELAY_BATCH = 50;
/** Retry delays grow 2^n seconds, capped at 10 minutes. */
export const MAX_BACKOFF_SECONDS = 600;

interface PendingRow extends Record<string, unknown> {
  id: string;
  topic: string;
  partition_key: string;
  payload: unknown;
  attempts: number;
}

/**
 * Publishes outbox rows in order of creation. Rows are claimed with FOR UPDATE SKIP LOCKED, so
 * several replicas can run the relay without sending an event twice from the same batch. Delivery
 * is at least once; consumers dedupe on eventId (spec 7).
 */
export class OutboxRelay {
  readonly #db: NodePgDatabase;
  readonly #publisher: EventPublisher;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: {
    db: NodePgDatabase;
    publisher: EventPublisher;
    logger: Logger;
    now?: () => Date;
  }) {
    this.#db = options.db;
    this.#publisher = options.publisher;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  /** Publishes one batch. Returns how many events were sent. */
  async runOnce(): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const now = this.#now();
      const { rows } = await tx.execute<PendingRow>(sql`
        select id, topic, partition_key, payload, attempts
          from ${outbox}
         where published_at is null and next_attempt_at <= ${now}
         order by created_at
         limit ${RELAY_BATCH}
         for update skip locked`);
      let sent = 0;
      for (const row of rows) {
        try {
          await this.#publisher.publish(row.topic, row.partition_key, row.payload);
          await tx.execute(sql`update ${outbox} set published_at = ${now} where id = ${row.id}`);
          sent += 1;
        } catch (err) {
          const delay = Math.min(2 ** (row.attempts + 1), MAX_BACKOFF_SECONDS);
          await tx.execute(sql`
            update ${outbox}
               set attempts = attempts + 1,
                   next_attempt_at = ${new Date(now.getTime() + delay * 1000)}
             where id = ${row.id}`);
          this.#logger.warn({ err, eventId: row.id, topic: row.topic }, 'event publish failed');
        }
      }
      return sent;
    });
  }
}
