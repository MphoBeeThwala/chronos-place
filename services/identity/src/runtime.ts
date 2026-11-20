import { KMSClient } from '@aws-sdk/client-kms';
import { KmsKeyWrapper, SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import type { ReadinessRegistry, ServiceConfig } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import pg from 'pg';
import { DrizzleAccountStore } from './accounts/account-store.js';
import { AccountService, SIGN_IN_STATUSES } from './accounts/account.service.js';
import { DEVELOPMENT_ENVIRONMENTS, type identityConfig } from './config.js';
import { DrizzleAccountKeyStore } from './crypto/account-key-store.js';
import { DrizzleChallengeStore } from './otp/challenge-store.js';
import { CodeHasher } from './otp/code.js';
import { KeyedHasher } from './otp/keyed-hash.js';
import { MailpitOtpSender, type OtpSender } from './otp/otp-sender.js';
import { IDENTITY_KEY_PURPOSE, OtpService } from './otp/otp.service.js';
import { RedisRateLimitStore } from './otp/rate-limiter.js';
import {
  type AccessTokenSigner,
  KmsAccessTokenSigner,
  LocalAccessTokenSigner,
} from './sessions/access-token.js';
import { DrizzleSessionStore } from './sessions/session-store.js';
import { SessionService } from './sessions/session.service.js';

export type IdentityConfig = ServiceConfig<typeof identityConfig>;

export interface IdentityRuntime {
  otp: OtpService;
  accounts: AccountService;
  sessions: SessionService;
  signer: AccessTokenSigner;
  close: () => Promise<void>;
}

/** Thrown at start-up for a configuration that is valid in shape but not allowed here. */
export class IdentityConfigError extends Error {}

const isDevelopment = (env: string) =>
  (DEVELOPMENT_ENVIRONMENTS as readonly string[]).includes(env);

function keyFrom(name: string, base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length < 32) throw new IdentityConfigError(`${name} must decode to at least 32 bytes`);
  return key;
}

export interface RuntimeOverrides {
  sender?: OtpSender;
  signer?: AccessTokenSigner;
  keyring?: SubjectKeyring;
}

/** Builds the service's dependencies from validated config. Tests can override the edges. */
export function createIdentityRuntime(
  config: IdentityConfig,
  logger: Logger,
  readiness: ReadinessRegistry,
  overrides: RuntimeOverrides = {},
): IdentityRuntime {
  const development = isDevelopment(config.NODE_ENV);
  if (!development && config.ACCESS_TOKEN_KEY_ID === undefined && !overrides.signer) {
    throw new IdentityConfigError(`ACCESS_TOKEN_KEY_ID is required in ${config.NODE_ENV}`);
  }
  // OTP_SENDER has only "mailpit" until an SMS provider is contracted (ADR-0006). Refusing to start
  // elsewhere beats silently not sending codes. Add the provider here when it exists.
  if (!development && !overrides.sender) {
    throw new IdentityConfigError(`no SMS provider is available in ${config.NODE_ENV}`);
  }

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL.reveal(), max: 10 });
  const db = drizzle(pool);
  const redis = new Redis(config.REDIS_URL.reveal(), { maxRetriesPerRequest: 2 });
  const kms = new KMSClient({
    region: config.AWS_REGION,
    ...(config.KMS_ENDPOINT ? { endpoint: config.KMS_ENDPOINT } : {}),
  });

  readiness.register('postgres', async () => {
    await pool.query('select 1');
  });
  readiness.register('redis', async () => {
    await redis.ping();
  });

  const keyring =
    overrides.keyring ??
    new SubjectKeyring({
      wrapper: new KmsKeyWrapper({ keyId: config.IDENTITY_DATA_KEY_ID, client: kms }),
      store: new DrizzleAccountKeyStore(db),
      purpose: IDENTITY_KEY_PURPOSE,
    });
  const signer =
    overrides.signer ??
    (config.ACCESS_TOKEN_KEY_ID === undefined
      ? new LocalAccessTokenSigner()
      : new KmsAccessTokenSigner({ client: kms, keyId: config.ACCESS_TOKEN_KEY_ID }));
  const lookupHasher = new KeyedHasher(
    keyFrom('PHONE_LOOKUP_KEY', config.PHONE_LOOKUP_KEY.reveal()),
  );
  const accountStore = new DrizzleAccountStore(db);

  const otp = new OtpService({
    challenges: new DrizzleChallengeStore(db),
    limits: new RedisRateLimitStore(redis),
    sender: overrides.sender ?? new MailpitOtpSender({ baseUrl: config.MAILPIT_URL }),
    keyring,
    lookupHasher,
    codeHasher: new CodeHasher(keyFrom('OTP_CODE_KEY', config.OTP_CODE_KEY.reveal())),
    logger,
  });
  const sessions = new SessionService({
    sessions: new DrizzleSessionStore(db),
    signer,
    deviceHasher: lookupHasher,
    accountStatus: async (id) => (await accountStore.get(id))?.status,
    allowedStatuses: SIGN_IN_STATUSES,
    logger,
  });
  const accounts = new AccountService({
    accounts: accountStore,
    keyring,
    revokeAllSessions: (id, reason) => sessions.revokeAll(id, reason),
    logger,
  });

  return {
    otp,
    accounts,
    sessions,
    signer,
    close: async () => {
      keyring.clearCache();
      redis.disconnect();
      await pool.end();
      kms.destroy();
    },
  };
}
