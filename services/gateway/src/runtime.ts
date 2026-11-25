import type { Logger } from '@chronos/logger';
import type { ServiceConfig } from '@chronos/service-kit';
import { AccountStatus } from '@chronos/contracts/identity';
import { Redis } from 'ioredis';
import type { AccountInfo, AccountState } from './auth/guard.js';
import { type RefreshLock, RedisRefreshLock } from './auth/refresh-lock.js';
import { SigningKeyCache } from './auth/signing-keys.js';
import { PersistedOperations } from './limits/persisted-operations.js';
import { type RateLimitStore, RateLimiter, RedisRateLimitStore } from './limits/rate-limit.js';
import { DEVELOPMENT_ENVIRONMENTS, type gatewayConfig } from './config.js';
import { IdentityClient } from './identity/identity-client.js';
import { IDENTITY_PROTO } from './identity/proto.js';

export type GatewayConfig = ServiceConfig<typeof gatewayConfig>;

/**
 * How long an account's state and verified flag are cached for the guard. Onboarding and consent
 * mutations clear it, so a withdrawn biometric consent closes the verified gate at once.
 */
export const ACCOUNT_STATE_TTL_MS = 15_000;

export interface GatewayRuntime {
  identity: IdentityClient;
  keys: SigningKeyCache;
  /** State and verified flag of an account, cached briefly for the guard. */
  accountInfo: (accountId: string) => Promise<AccountInfo>;
  forgetAccountState: (accountId: string) => void;
  refreshLock: RefreshLock;
  rateLimiter: RateLimiter;
  /** Approved operations; undefined only in development without a manifest. */
  persistedOperations: PersistedOperations | undefined;
  /** True outside development: only approved operations run. */
  enforcePersistedOperations: boolean;
  close: () => void;
}

const stateOf = (status: AccountStatus): AccountState =>
  status === AccountStatus.ACCOUNT_STATUS_ACTIVE
    ? 'active'
    : status === AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING
      ? 'pending_onboarding'
      : 'unavailable';

export function createGatewayRuntime(
  config: GatewayConfig,
  logger: Logger,
  overrides: {
    identity?: IdentityClient;
    refreshLock?: RefreshLock;
    rateLimitStore?: RateLimitStore;
    persistedOperations?: PersistedOperations;
    /** Tests switch on production's enforcement without production's mTLS setup. */
    enforcePersistedOperations?: boolean;
  } = {},
): GatewayRuntime {
  const identity =
    overrides.identity ??
    new IdentityClient({ address: config.IDENTITY_GRPC_ADDRESS, protoPath: IDENTITY_PROTO });
  const keys = new SigningKeyCache({
    fetch: async () =>
      (await identity.call<{ keys: { kid: string; jwkJson: string }[] }>('getSigningKeys', {}))
        .keys,
  });

  const development = (DEVELOPMENT_ENVIRONMENTS as readonly string[]).includes(config.NODE_ENV);
  const persistedOperations =
    overrides.persistedOperations ??
    (config.PERSISTED_OPERATIONS_PATH === undefined
      ? undefined
      : PersistedOperations.fromFile(config.PERSISTED_OPERATIONS_PATH));
  if (!development && persistedOperations === undefined) {
    throw new Error('PERSISTED_OPERATIONS_PATH is required outside development');
  }

  const needsRedis = !overrides.refreshLock || !overrides.rateLimitStore;
  const redis = needsRedis
    ? new Redis(config.REDIS_URL.reveal(), { maxRetriesPerRequest: 2 })
    : undefined;
  const refreshLock = overrides.refreshLock ?? new RedisRefreshLock(redis as Redis);
  const rateLimiter = new RateLimiter(
    overrides.rateLimitStore ?? new RedisRateLimitStore(redis as Redis),
    Buffer.from(config.RATE_LIMIT_HASH_KEY.reveal(), 'base64'),
  );

  const states = new Map<string, { info: AccountInfo; at: number }>();
  const accountInfo = async (accountId: string): Promise<AccountInfo> => {
    const cached = states.get(accountId);
    if (cached && Date.now() - cached.at < ACCOUNT_STATE_TTL_MS) return cached.info;
    try {
      const { account } = await identity.call<{
        account: { status: AccountStatus; verified: boolean };
      }>('getAccount', { accountId });
      const info: AccountInfo = { state: stateOf(account.status), verified: account.verified };
      states.set(accountId, { info, at: Date.now() });
      if (states.size > 50_000) states.clear();
      return info;
    } catch (err) {
      logger.warn({ err }, 'account state lookup failed');
      return { state: 'unavailable', verified: false };
    }
  };

  return {
    identity,
    keys,
    accountInfo,
    forgetAccountState: (accountId) => states.delete(accountId),
    refreshLock,
    rateLimiter,
    persistedOperations,
    enforcePersistedOperations: overrides.enforcePersistedOperations ?? !development,
    close: () => {
      identity.close();
      redis?.disconnect();
    },
  };
}
