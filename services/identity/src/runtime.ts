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
import { ConsentService } from './consent/consent.service.js';
import { DrizzleConsentStore } from './consent/consent-store.js';
import { type VaultEraser, VaultErasureRelay } from './consent/vault-erasure-relay.js';
import { DrizzleAccountKeyStore } from './crypto/account-key-store.js';
import { type EventPublisher, OutboxRelay } from './events/outbox.js';
import { IdentityCleanup } from './maintenance/cleanup.js';
import { every } from './maintenance/scheduler.js';
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
import { type CaptureStore, InMemoryCaptureStore } from './verification/capture-store.js';
import { FakeLivenessProvider, type LivenessProvider } from './verification/provider.js';
import { DrizzleVerificationStore } from './verification/verification-store.js';
import { VerificationService } from './verification/verification.service.js';
import { VerificationWorker } from './verification/verification-worker.js';
import { isDraftPolicy } from './consent/policies.js';

export type IdentityConfig = ServiceConfig<typeof identityConfig>;

export interface IdentityRuntime {
  consents: ConsentService;
  otp: OtpService;
  accounts: AccountService;
  sessions: SessionService;
  verification: VerificationService;
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

/** How often background work runs. */
export const RELAY_INTERVAL_MS = 1_000;
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
export const VAULT_ERASURE_INTERVAL_MS = 30_000;
export const VERIFICATION_INTERVAL_MS = 5_000;

export interface RuntimeOverrides {
  /** Where outbox events go. Kafka once ADR-0019 is accepted; until then events wait in the outbox. */
  publisher?: EventPublisher;
  /** The Disclosure Service's EraseSubject (M2). Until then, erasure requests wait in the queue. */
  vaultEraser?: VaultEraser;
  sender?: OtpSender;
  signer?: AccessTokenSigner;
  keyring?: SubjectKeyring;
  /** The liveness vendor (ADR-0022). Development uses the fake one when none is given. */
  livenessProvider?: LivenessProvider;
  /** Object storage for sealed captures. Development keeps them in memory when none is given. */
  captureStore?: CaptureStore;
}

/**
 * Picks the liveness vendor and capture storage. Outside development a real vendor runs only when
 * one is supplied, with object storage, and only once counsel has approved the biometric consent
 * text; otherwise verification is switched off and SubmitLiveness answers UNAVAILABLE.
 */
function verificationEdges(
  development: boolean,
  overrides: RuntimeOverrides,
  logger: Logger,
): { provider: LivenessProvider | undefined; captures: CaptureStore } {
  if (development) {
    if (!overrides.livenessProvider) logger.warn('liveness: using the fake provider (development)');
    return {
      provider: overrides.livenessProvider ?? new FakeLivenessProvider(),
      captures: overrides.captureStore ?? new InMemoryCaptureStore(),
    };
  }
  if (!overrides.livenessProvider) {
    logger.warn('liveness verification disabled: no vendor configured');
    return { provider: undefined, captures: new InMemoryCaptureStore() };
  }
  if (!overrides.captureStore) {
    throw new IdentityConfigError('a capture store is required with a liveness provider');
  }
  if (isDraftPolicy('biometric_verification')) {
    throw new IdentityConfigError('the biometric consent text is a draft: counsel must approve it');
  }
  return { provider: overrides.livenessProvider, captures: overrides.captureStore };
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

  const { provider, captures } = verificationEdges(development, overrides, logger);

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
  // Accounts and consents depend on each other only through these closures, called after start-up.
  const accounts: AccountService = new AccountService({
    accounts: accountStore,
    keyring,
    revokeAllSessions: (id, reason) => sessions.revokeAll(id, reason),
    hasActivationConsents: (id): Promise<boolean> => consents.hasActivationConsents(id),
    logger,
  });
  const consents: ConsentService = new ConsentService({
    consents: new DrizzleConsentStore(db),
    getAccount: (id): ReturnType<AccountService['get']> => accounts.get(id),
    revokeAllSessions: (id, reason) => sessions.revokeAll(id, reason),
    forgetVerification: (id) => verification.forget(id),
    logger,
  });
  const verificationStore = new DrizzleVerificationStore(db);
  const verification: VerificationService = new VerificationService({
    store: verificationStore,
    captures,
    provider,
    keyring,
    getAccount: (id) => accounts.get(id),
    hasConsent: (id) => consents.hasCurrentConsent(id, 'biometric_verification'),
    logger,
  });

  const stopCleanup = every(
    'identity-cleanup',
    CLEANUP_INTERVAL_MS,
    () => new IdentityCleanup({ db, keyring, logger }).runOnce(),
    logger,
  );
  let stopRelay: () => Promise<void> = () => Promise.resolve();
  if (overrides.publisher) {
    const relay = new OutboxRelay({ db, publisher: overrides.publisher, logger });
    stopRelay = every('outbox-relay', RELAY_INTERVAL_MS, () => relay.runOnce(), logger);
  } else {
    // Nothing is lost: events stay in identity.outbox until a publisher is configured.
    logger.warn('event relay disabled: no Kafka publisher yet (ADR-0019)');
  }

  let stopVerification: () => Promise<void> = () => Promise.resolve();
  if (provider) {
    const worker = new VerificationWorker({
      store: verificationStore,
      captures,
      provider,
      keyring,
      logger,
    });
    stopVerification = every(
      'verification',
      VERIFICATION_INTERVAL_MS,
      () => worker.runOnce(),
      logger,
    );
  }

  let stopVaultErasure: () => Promise<void> = () => Promise.resolve();
  if (overrides.vaultEraser) {
    const relay = new VaultErasureRelay({ db, eraser: overrides.vaultEraser, logger });
    stopVaultErasure = every(
      'vault-erasure',
      VAULT_ERASURE_INTERVAL_MS,
      () => relay.runOnce(),
      logger,
    );
  } else {
    // Requests are kept in identity.vault_erasure_requests until the Disclosure Service exists.
    logger.warn('vault erasure relay disabled: no Disclosure Service yet (M2)');
  }

  return {
    consents,
    otp,
    accounts,
    sessions,
    verification,
    signer,
    close: async () => {
      await Promise.all([stopCleanup(), stopRelay(), stopVaultErasure(), stopVerification()]);
      keyring.clearCache();
      redis.disconnect();
      await pool.end();
      kms.destroy();
    },
  };
}
