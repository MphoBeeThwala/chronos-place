import { hostList, postgresUrl } from '@chronos/config';

/** The matching service's own settings, merged with the kit's. */
export const matchingConfig = {
  DATABASE_URL: postgresUrl,
  /** Kafka brokers for the outbox relay (ADR-0019). Unset: events wait safely in the outbox. */
  KAFKA_BROKERS: hostList.optional(),
};
