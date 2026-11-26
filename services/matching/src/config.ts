import { hostList, postgresUrl } from '@chronos/config';

/** The matching service's own settings, merged with the kit's. */
export const matchingConfig = {
  DATABASE_URL: postgresUrl,
  /**
   * Kafka brokers (ADR-0019): the outbox relay, and account.erasure_requested in (ADR-0025). Unset:
   * events wait safely in the outbox and erasure requests wait in Kafka.
   */
  KAFKA_BROKERS: hostList.optional(),
};
