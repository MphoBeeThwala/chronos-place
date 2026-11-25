import { createLogger } from '@chronos/logger';
import { ReadinessRegistry } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { createProfileRuntime, type ProfileConfig, ProfileConfigError } from '../src/runtime.js';

const logger = createLogger({ service: 'profile-test', destination: { write: () => undefined } });

describe('photo storage config (ADR-0024)', () => {
  it('refuses to start outside development without buckets, before connecting', () => {
    for (const NODE_ENV of ['staging', 'production']) {
      // Only the fields read before the check; nothing else is touched.
      const config = { NODE_ENV, AWS_REGION: 'af-south-1' } as unknown as ProfileConfig;
      expect(() => createProfileRuntime(config, logger, new ReadinessRegistry())).toThrow(
        ProfileConfigError,
      );
    }
  });
});
