import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { KmsKeyWrapper, SubjectKeyring } from '@chronos/crypto';
import { KafkaEventPublisher, KafkaEventSubscriber } from '@chronos/events';
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
import { DrizzleDeletionStore } from './deletion/deletion-store.js';
import { DeletionService } from './deletion/deletion.service.js';
import { DrizzleErasureStore } from './erasure/erasure-store.js';
import { ErasureService } from './erasure/erasure.service.js';
import { AccountExporter } from './export/account-export.js';
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
import { S3CaptureStore } from './verification/s3-capture-store.js';
import { SmileIdProvider } from './verification/smile-id.js';
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
  deletion: DeletionService;
  erasure: ErasureService;
  exporter: AccountExporter;
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
/** How often ready erasures are finished (ADR-0025 f: minutes, not days). */
export const ERASURE_INTERVAL_MS = 30_000;
export const VAULT_ERASURE_INTERVAL_MS = 30_000;
export const VERIFICATION_INTERVAL_MS = 5_000;

export interface RuntimeOverrides {
  /** Where outbox events go. Defaults to Kafka when KAFKA_BROKERS is set; otherwise they wait. */
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
 * The vendor and capture storage named in config (LIVENESS_PROVIDER), unless a test supplies its
 * own. "smile-id" needs its credentials and a bucket; "fake" supplies nothing here.
 */
function configuredEdges(
  config: IdentityConfig,
  overrides: RuntimeOverrides,
): { provider?: LivenessProvider; captures?: CaptureStore; close: () => void } {
  if (overrides.livenessProvider || config.LIVENESS_PROVIDER !== 'smile-id') {
    return {
      ...(overrides.livenessProvider ? { provider: overrides.livenessProvider } : {}),
      ...(overrides.captureStore ? { captures: overrides.captureStore } : {}),
      close: () => undefined,
    };
  }
  const {
    SMILE_ID_PARTNER_ID: partnerId,
    SMILE_ID_API_KEY: apiKey,
    CAPTURE_BUCKET: bucket,
  } = config;
  if (partnerId === undefined || apiKey === undefined || bucket === undefined) {
    throw new IdentityConfigError(
      'smile-id needs SMILE_ID_PARTNER_ID, SMILE_ID_API_KEY and CAPTURE_BUCKET',
    );
  }
  const s3 = new S3Client({
    region: config.AWS_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  return {
    provider: new SmileIdProvider({ partnerId, apiKey, environment: config.SMILE_ID_ENVIRONMENT }),
    captures: overrides.captureStore ?? new S3CaptureStore(s3, bucket),
    close: () => {
      s3.destroy();
    },
  };
}

/**
 * Picks the liveness vendor and capture storage. Outside development a real vendor runs only when
 * one is configured, with object storage, and only once counsel has approved the biometric consent
 * text; otherwise verification is switched off and SubmitLiveness answers UNAVAILABLE.
 */
function verificationEdges(
  development: boolean,
  configured: { provider?: LivenessProvider; captures?: CaptureStore },
  logger: Logger,
): { provider: LivenessProvider | undefined; captures: CaptureStore } {
  if (development) {
    if (!configured.provider) logger.warn('liveness: using the fake provider (development)');
    return {
      provider: configured.provider ?? new FakeLivenessProvider(),
      captures: configured.captures ?? new InMemoryCaptureStore(),
    };
  }
  if (!configured.provider) {
    logger.warn('liveness verification disabled: no vendor configured');
    return { provider: undefined, captures: new InMemoryCaptureStore() };
  }
  if (!configured.captures) {
    throw new IdentityConfigError('a capture store is required with a liveness provider');
  }
  if (isDraftPolicy('biometric_verification')) {
    throw new IdentityConfigError('the biometric consent text is a draft: counsel must approve it');
  }
  return { provider: configured.provider, captures: configured.captures };
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

  const configured = configuredEdges(config, overrides);
  let edges: ReturnType<typeof verificationEdges>;
  try {
    edges = verificationEdges(development, configured, logger);
  } catch (err) {
    configured.close();
    throw err;
  }
  const { provider, captures } = edges;

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

  // Sign-in and deletion codes share the limits store, sender and hashers (ADR-0025).
  const codeDeps = {
    limits: new RedisRateLimitStore(redis),
    sender: overrides.sender ?? new MailpitOtpSender({ baseUrl: config.MAILPIT_URL }),
    keyring,
    lookupHasher,
    codeHasher: new CodeHasher(keyFrom('OTP_CODE_KEY', config.OTP_CODE_KEY.reveal())),
    logger,
  };
  const otp = new OtpService({ challenges: new DrizzleChallengeStore(db), ...codeDeps });
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
  const deletion = new DeletionService({
    store: new DrizzleDeletionStore(db),
    ...codeDeps,
    revokeAllSessions: (id, reason) => sessions.revokeAll(id, reason),
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

  const erasure = new ErasureService({
    store: new DrizzleErasureStore(db),
    keyring,
    services: config.ERASURE_CONFIRMING_SERVICES,
    forgetVerification: (id) => verification.forget(id),
    logger,
  });
  const stopErasure = every('erasure', ERASURE_INTERVAL_MS, () => erasure.runOnce(), logger);
  // Confirmations arrive as account.erasure_confirmed; without Kafka they wait in each service.
  const confirmations = config.KAFKA_BROKERS
    ? new KafkaEventSubscriber({ brokers: config.KAFKA_BROKERS, clientId: 'identity', logger })
    : undefined;
  if (confirmations) {
    confirmations.subscribe('account.erasure_confirmed', (event) => erasure.confirmed(event));
    // In the background: start-up stays synchronous. Unconsumed confirmations wait in Kafka.
    confirmations.start().catch((err: unknown) => {
      logger.error({ err }, 'erasure confirmations not consumed');
    });
  }

  const stopCleanup = every(
    'identity-cleanup',
    CLEANUP_INTERVAL_MS,
    () => new IdentityCleanup({ db, keyring, logger }).runOnce(),
    logger,
  );
  let stopRelay: () => Promise<void> = () => Promise.resolve();
  const kafka = config.KAFKA_BROKERS
    ? new KafkaEventPublisher({ brokers: config.KAFKA_BROKERS, clientId: 'identity', logger })
    : undefined;
  const publisher = overrides.publisher ?? kafka;
  if (publisher) {
    const relay = new OutboxRelay({ db, publisher, logger });
    const stopEvery = every('outbox-relay', RELAY_INTERVAL_MS, () => relay.runOnce(), logger);
    stopRelay = async () => {
      await stopEvery();
      await kafka?.close();
    };
  } else {
    // Nothing is lost: events stay in identity.outbox until KAFKA_BROKERS is set.
    logger.warn('event relay disabled: KAFKA_BROKERS is not set (ADR-0019)');
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
    deletion,
    erasure,
    exporter: new AccountExporter({ db, keyring, logger }),
    signer,
    close: async () => {
      await Promise.all([
        stopCleanup(),
        stopRelay(),
        stopVaultErasure(),
        stopVerification(),
        stopErasure(),
        confirmations?.close(),
      ]);
      configured.close();
      keyring.clearCache();
      redis.disconnect();
      await pool.end();
      kms.destroy();
    },
  };
}
