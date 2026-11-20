import type { Logger } from '@chronos/logger';
import type { ServiceConfig } from '@chronos/service-kit';
import { AccountStatus } from '@chronos/contracts/identity';
import type { AccountState } from './auth/guard.js';
import { SigningKeyCache } from './auth/signing-keys.js';
import type { gatewayConfig } from './config.js';
import { IdentityClient } from './identity/identity-client.js';
import { IDENTITY_PROTO } from './identity/proto.js';

export type GatewayConfig = ServiceConfig<typeof gatewayConfig>;

/** How long an account's state is cached for the guard. Onboarding mutations clear it (PR 2). */
export const ACCOUNT_STATE_TTL_MS = 15_000;

export interface GatewayRuntime {
  identity: IdentityClient;
  keys: SigningKeyCache;
  accountState: (accountId: string) => Promise<AccountState>;
  forgetAccountState: (accountId: string) => void;
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
  overrides: { identity?: IdentityClient } = {},
): GatewayRuntime {
  const identity =
    overrides.identity ??
    new IdentityClient({ address: config.IDENTITY_GRPC_ADDRESS, protoPath: IDENTITY_PROTO });
  const keys = new SigningKeyCache({
    fetch: async () =>
      (await identity.call<{ keys: { kid: string; jwkJson: string }[] }>('getSigningKeys', {}))
        .keys,
  });

  const states = new Map<string, { state: AccountState; at: number }>();
  const accountState = async (accountId: string): Promise<AccountState> => {
    const cached = states.get(accountId);
    if (cached && Date.now() - cached.at < ACCOUNT_STATE_TTL_MS) return cached.state;
    try {
      const { account } = await identity.call<{ account: { status: AccountStatus } }>(
        'getAccount',
        {
          accountId,
        },
      );
      const state = stateOf(account.status);
      states.set(accountId, { state, at: Date.now() });
      if (states.size > 50_000) states.clear();
      return state;
    } catch (err) {
      logger.warn({ err }, 'account state lookup failed');
      return 'unavailable';
    }
  };

  return {
    identity,
    keys,
    accountState,
    forgetAccountState: (accountId) => states.delete(accountId),
    close: () => {
      identity.close();
    },
  };
}
