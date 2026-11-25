import { loadConfig } from '@chronos/config';
import { RedpandaContainer } from '@testcontainers/redpanda';
import { z } from 'zod';

/** Same image as tools/docker-compose.yml. */
const IMAGE = 'redpandadata/redpanda:v25.1.7';

/**
 * A Kafka broker for a test file: Testcontainers Redpanda (needs Docker), or an existing broker
 * when TEST_KAFKA_BROKERS lists one (each test uses its own topic names and consumer group).
 */
export async function startTestBroker(): Promise<{ brokers: string[]; stop: () => Promise<void> }> {
  const { TEST_KAFKA_BROKERS: external } = loadConfig(
    z.object({ TEST_KAFKA_BROKERS: z.string().optional() }),
  );
  if (external !== undefined && external !== '') {
    return { brokers: external.split(','), stop: () => Promise.resolve() };
  }
  const container = await new RedpandaContainer(IMAGE).start();
  return {
    brokers: [container.getBootstrapServers()],
    stop: () => container.stop().then(() => undefined),
  };
}
