import { createServer } from 'node:net';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { createAppModule, type AppModuleOptions } from '../../src/app.module.js';
import { gatewayConfig } from '../../src/config.js';
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
  options: AppModuleOptions = {},
): Promise<TestGateway> {
  const port = await freePort();
  const service = await bootstrapService({
    module: createAppModule(options),
    extraConfig: gatewayConfig,
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'gateway',
      HTTP_PORT: String(port),
      SHUTDOWN_DRAIN_MS: '0',
      IDENTITY_GRPC_ADDRESS: `127.0.0.1:${String(identity.port)}`,
      TRUSTED_PROXY_HOPS: '0',
    },
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
