import { createServer } from 'node:net';
import { InMemoryEventBus } from '@chronos/events';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import { MATCHING_ALLOW_LIST } from '../../src/allow-list.js';
import { createAppModule } from '../../src/app.module.js';
import { matchingConfig } from '../../src/config.js';
import { MATCHING_PACKAGE, MATCHING_PROTO } from '../../src/proto.js';

type Call<Req, Res> = (request: Req) => Observable<Res>;
type Pair<A extends string, B extends string> = Record<A | B, string>;

export interface MatchingClient {
  like: Call<Pair<'fromAccountId', 'toAccountId'>, { matched: boolean; matchId: string }>;
  pass: Call<Pair<'fromAccountId', 'toAccountId'>, object>;
  unmatch: Call<{ accountId: string; matchId: string }, object>;
  block: Call<Pair<'blockerAccountId', 'blockedAccountId'>, object>;
  unblock: Call<Pair<'blockerAccountId', 'blockedAccountId'>, object>;
  listMatches: Call<
    { accountId: string; pageSize?: number; pageToken?: string },
    {
      matches?: { matchId: string; otherAccountId: string; createdAt: unknown }[];
      nextPageToken: string;
    }
  >;
  listBlocked: Call<
    { accountId: string },
    { blocked?: { accountId: string; blockedAt: unknown }[] }
  >;
  getRelationship: Call<
    Pair<'accountId', 'otherAccountId'>,
    { blocked: boolean; activeMatchId: string }
  >;
  filterVisible: Call<
    { viewerAccountId: string; candidateAccountIds: string[] },
    { visibleAccountIds?: string[] }
  >;
}

const freePort = (): Promise<number> =>
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

/** The real service over gRPC (allow-list off without TLS in tests), with an in-memory event bus. */
export async function startService(databaseUrl: string) {
  const bus = new InMemoryEventBus();
  const grpcPort = await freePort();
  const service: RunningService = await bootstrapService({
    module: createAppModule({ publisher: bus, subscriber: bus }),
    extraConfig: matchingConfig,
    grpc: { packageName: MATCHING_PACKAGE, protoPath: MATCHING_PROTO },
    allowList: MATCHING_ALLOW_LIST,
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'matching',
      HTTP_PORT: String(await freePort()),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      DATABASE_URL: databaseUrl,
    },
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit: () => undefined,
  });
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: MATCHING_PACKAGE,
      protoPath: MATCHING_PROTO,
      url: `127.0.0.1:${String(grpcPort)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  return {
    client: proxy.getService<MatchingClient>('MatchingService'),
    bus,
    stop: async () => {
      proxy.close();
      await service.shutdown('test');
    },
  };
}

export async function grpcError(promise: Promise<unknown>): Promise<number | undefined> {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: number } | undefined;
  return error?.code;
}
