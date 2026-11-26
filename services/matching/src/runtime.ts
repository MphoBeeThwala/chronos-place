import { type EventSubscriber, KafkaEventPublisher, KafkaEventSubscriber } from '@chronos/events';
import type { Logger } from '@chronos/logger';
import type { ReadinessRegistry, ServiceConfig } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { matchingConfig } from './config.js';
import { type EventPublisher, OutboxRelay } from './events/outbox.js';
import { every } from './events/scheduler.js';
import { MatchingStore } from './matching/matching-store.js';

export type MatchingConfig = ServiceConfig<typeof matchingConfig>;

/** How often the outbox relay sends waiting events. */
export const RELAY_INTERVAL_MS = 1_000;

export interface RuntimeOverrides {
  /** Where outbox events go. Defaults to Kafka when KAFKA_BROKERS is set; otherwise they wait. */
  publisher?: EventPublisher;
  /** Where erasure requests come from. Defaults to Kafka when KAFKA_BROKERS is set. */
  subscriber?: EventSubscriber;
  now?: () => Date;
}

export interface MatchingRuntime {
  store: MatchingStore;
  close: () => Promise<void>;
}

export function createMatchingRuntime(
  config: MatchingConfig,
  readiness: ReadinessRegistry,
  logger: Logger,
  overrides: RuntimeOverrides = {},
): MatchingRuntime {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL.reveal(), max: 10 });
  readiness.register('database', async () => {
    await pool.query('select 1');
  });
  const db = drizzle(pool);
  const store = new MatchingStore(db, overrides.now);

  const kafka =
    overrides.publisher === undefined && config.KAFKA_BROKERS
      ? new KafkaEventPublisher({ brokers: config.KAFKA_BROKERS, clientId: 'matching', logger })
      : undefined;
  const publisher = overrides.publisher ?? kafka;
  let stopRelay: () => Promise<void> = () => Promise.resolve();
  if (publisher) {
    const relay = new OutboxRelay({ db, publisher, logger });
    stopRelay = every('outbox-relay', RELAY_INTERVAL_MS, () => relay.runOnce(), logger);
  } else {
    logger.warn('outbox relay disabled: KAFKA_BROKERS is not set');
  }

  // Account erasure (ADR-0025 d): requests come from identity; the confirmation leaves via the outbox.
  const subscriber =
    overrides.subscriber ??
    (config.KAFKA_BROKERS
      ? new KafkaEventSubscriber({ brokers: config.KAFKA_BROKERS, clientId: 'matching', logger })
      : undefined);
  if (subscriber) {
    subscriber.subscribe('account.erasure_requested', async (event) => {
      const counts = await store.erase(event.data.accountId);
      logger.info({ accountId: event.data.accountId, ...counts }, 'matching data erased');
    });
    // In the background: start-up stays synchronous. Unconsumed requests wait in Kafka.
    subscriber.start().catch((err: unknown) => {
      logger.error({ err }, 'erasure requests not consumed');
    });
  } else {
    logger.warn('erasure requests not consumed: KAFKA_BROKERS is not set (ADR-0025)');
  }

  return {
    store,
    close: async () => {
      await subscriber?.close();
      await stopRelay();
      await kafka?.close();
      await pool.end();
    },
  };
}
