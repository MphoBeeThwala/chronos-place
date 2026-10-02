import { inspect } from 'node:util';
import {
  baseSchema,
  ConfigError,
  loadConfig,
  postgresUrl,
  redisUrl,
  secret,
} from '@chronos/config';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { usePrivacyHarness } from '../src/vitest.js';

const schema = baseSchema.and(
  z.object({
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    SIGNING_SECRET: secret(),
    PORT: z.coerce.number().int().min(1).max(65535),
  }),
);

describe('configuration never repeats a secret', () => {
  const privacy = usePrivacyHarness();

  it('in errors for invalid values', () => {
    const s = privacy.markers.secret();
    try {
      loadConfig(schema, {
        env: {
          NODE_ENV: 'bogus',
          SERVICE_NAME: 'privacy',
          DATABASE_URL: `mysql://user:${s}@host/db`,
          REDIS_URL: `http://${s}`,
          SIGNING_SECRET: 'short',
          PORT: `bad-${s}`,
        },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const e = error as Error;
      privacy.logs.destination.write(
        JSON.stringify({
          err: e.message,
          json: JSON.stringify(e),
          shown: inspect(e),
          stack: e.stack,
        }),
      );
      privacy.grpc.recordError({ code: 13, details: e.message });
    }
  });

  it('in the loaded config, however it is printed', () => {
    const s = privacy.markers.secret();
    const config = loadConfig(schema, {
      env: {
        NODE_ENV: 'test',
        SERVICE_NAME: 'privacy',
        DATABASE_URL: `postgres://user:${s}@host:5432/db`,
        REDIS_URL: `redis://:${s}@host:6379`,
        SIGNING_SECRET: s,
        PORT: '8080',
      },
    });
    privacy.logs.destination.write(
      JSON.stringify({
        json: JSON.stringify(config),
        shown: inspect(config, { depth: 6 }),
        text: String(config.SIGNING_SECRET),
      }),
    );
    expect(config.SIGNING_SECRET.reveal()).toBe(s);
  });
});
