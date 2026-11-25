import { createServer } from 'node:net';
import type { Logger } from '@chronos/logger';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { createAppModule, type AppModuleOptions } from '../../src/app.module.js';
import { InMemoryRefreshLock, type RefreshLock } from '../../src/auth/refresh-lock.js';
import { gatewayConfig } from '../../src/config.js';
import type { PersistedOperations } from '../../src/limits/persisted-operations.js';
import { InMemoryRateLimitStore, type RateLimitStore } from '../../src/limits/rate-limit.js';
import { createGatewayRuntime } from '../../src/runtime.js';
import type { FakeIdentity } from './fake-identity.js';

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });

export interface TestGateway {
  url: string;
  service: RunningService;
}

export async function startGateway(
  identity: FakeIdentity,
  options: AppModuleOptions & {
    refreshLock?: RefreshLock;
    logger?: Logger;
    rateLimitStore?: RateLimitStore;
    persistedOperations?: PersistedOperations;
    enforcePersistedOperations?: boolean;
  } = {},
): Promise<TestGateway> {
  const port = await freePort();
  const refreshLock = options.refreshLock ?? new InMemoryRefreshLock();
  const service = await bootstrapService({
    module: createAppModule({
      runtime: (config, logger) =>
        createGatewayRuntime(config, logger, {
          refreshLock,
          rateLimitStore: options.rateLimitStore ?? new InMemoryRateLimitStore(),
          ...(options.persistedOperations
            ? { persistedOperations: options.persistedOperations }
            : {}),
          ...(options.enforcePersistedOperations !== undefined
            ? { enforcePersistedOperations: options.enforcePersistedOperations }
            : {}),
        }),
      ...(options.resolvers ? { resolvers: options.resolvers } : {}),
    }),
    extraConfig: gatewayConfig,
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'gateway',
      HTTP_PORT: String(port),
      // The kit always runs a gRPC health server; give each test gateway its own port.
      GRPC_PORT: String(await freePort()),
      SHUTDOWN_DRAIN_MS: '0',
      IDENTITY_GRPC_ADDRESS: `127.0.0.1:${String(identity.port)}`,
      TRUSTED_PROXY_HOPS: '0',
      // Not contacted: the refresh lock is in memory in these tests.
      REDIS_URL: 'redis://127.0.0.1:1',
      RATE_LIMIT_HASH_KEY: 'c3ludGhldGljLXJhdGUtbGltaXQta2V5LWZvci10ZXN0cy0zMmI=',
    },
    ...(options.logger ? { logger: options.logger } : {}),
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit: () => undefined,
  });
  return { url: `http://127.0.0.1:${String(port)}/graphql`, service };
}

export interface GraphQLResponse {
  status: number;
  body: {
    data?: Record<string, unknown> | null;
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  setCookies: string[];
}

export async function gql(
  url: string,
  query: string,
  options: { variables?: object; cookie?: string; headers?: Record<string, string> } = {},
): Promise<GraphQLResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: JSON.stringify({ query, variables: options.variables ?? {} }),
  });
  return {
    status: response.status,
    body: (await response.json()) as GraphQLResponse['body'],
    setCookies: response.headers.getSetCookie(),
  };
}

export const codes = (r: GraphQLResponse) => (r.body.errors ?? []).map((e) => e.extensions?.code);
