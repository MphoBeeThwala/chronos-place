import { randomBytes } from 'node:crypto';
import { createLogger } from '@chronos/logger';
import { ReadinessRegistry, serviceConfigSchema } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { identityConfig } from '../src/config.js';
import { createIdentityRuntime, type IdentityConfig, IdentityConfigError } from '../src/runtime.js';

const logger = createLogger({ service: 'identity-test', destination: { write: () => undefined } });

function config(overrides: Record<string, string> = {}): IdentityConfig {
  return serviceConfigSchema(identityConfig).parse({
    NODE_ENV: 'production',
    SERVICE_NAME: 'identity',
    GRPC_TLS_CERT_PATH: '/certs/tls.crt',
    GRPC_TLS_KEY_PATH: '/certs/tls.key',
    GRPC_TLS_CA_PATH: '/certs/ca.crt',
    DATABASE_URL: 'postgres://identity:synthetic@db.invalid:5432/core',
    REDIS_URL: 'redis://redis.invalid:6379',
    IDENTITY_DATA_KEY_ID: 'alias/identity-data',
    PHONE_LOOKUP_KEY: randomBytes(32).toString('base64'),
    OTP_CODE_KEY: randomBytes(32).toString('base64'),
    ...overrides,
  });
}

describe('start-up refuses unsafe configuration', () => {
  it('requires a KMS signing key outside development', () => {
    expect(() => createIdentityRuntime(config(), logger, new ReadinessRegistry())).toThrow(
      IdentityConfigError,
    );
  });

  it('refuses the local Mailpit sender outside development (no SMS provider yet, ADR-0006)', () => {
    expect(() =>
      createIdentityRuntime(
        config({ ACCESS_TOKEN_KEY_ID: 'alias/access-tokens' }),
        logger,
        new ReadinessRegistry(),
      ),
    ).toThrow(/no SMS provider/);
  });

  it('rejects hash keys shorter than 32 bytes', () => {
    expect(() => config({ PHONE_LOOKUP_KEY: 'c2hvcnQ=' })).toThrow();
  });
});
