import { loadConfig } from '@chronos/config';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { z } from 'zod';

/** Same major as tools/docker-compose.yml. */
const IMAGE = 'redis:7-alpine';

export interface TestRedis {
  redis: Redis;
  stop: () => Promise<void>;
}

/** Testcontainers (needs Docker), or an existing server when TEST_REDIS_URL is set. */
export async function startTestRedis(): Promise<TestRedis> {
  const { TEST_REDIS_URL: external } = loadConfig(
    z.object({ TEST_REDIS_URL: z.string().optional() }),
  );
  if (external !== undefined && external !== '') {
    const redis = new Redis(external);
    return {
      redis,
      stop: async () => {
        await redis.quit();
      },
    };
  }
  const container = await new RedisContainer(IMAGE).start();
  const redis = new Redis(container.getConnectionUrl());
  return {
    redis,
    stop: async () => {
      await redis.quit();
      await container.stop();
    },
  };
}
