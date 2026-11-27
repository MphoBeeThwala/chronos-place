import { createServer } from 'node:net';
import { FeedOutcome } from '@chronos/contracts/discovery';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { status } from '@grpc/grpc-js';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCOVERY_ALLOW_LIST } from '../src/allow-list.js';
import { createAppModule } from '../src/app.module.js';
import { discoveryConfig } from '../src/config.js';
import { InMemoryFeedCache, MemoryFeedCache } from '../src/feed/feed-cache.js';
import { DISCOVERY_PACKAGE, DISCOVERY_PROTO } from '../src/proto.js';
import { FakeConditions, FakeFilter, FakeSource, member, VIEWER } from './support/fakes.js';

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

interface Discovery {
  getFeed: (r: {
    viewerAccountId: string;
    pageSize?: number;
    pageToken?: string;
  }) => Observable<{ outcome: number; accountIds?: string[]; nextPageToken: string }>;
}

const source = new FakeSource();
const filter = new FakeFilter();
let service: RunningService;
let http: string;
let client: Discovery;
let closeClient: () => void;

beforeAll(async () => {
  const [httpPort, grpcPort] = [await freePort(), await freePort()];
  http = `http://127.0.0.1:${String(httpPort)}`;
  service = await bootstrapService({
    module: createAppModule({
      source,
      filter,
      cache: new InMemoryFeedCache(),
      conditions: new FakeConditions(),
      memory: new MemoryFeedCache(),
    }),
    extraConfig: discoveryConfig,
    grpc: { packageName: DISCOVERY_PACKAGE, protoPath: DISCOVERY_PROTO },
    allowList: DISCOVERY_ALLOW_LIST,
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'discovery',
      HTTP_PORT: String(httpPort),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      // Not contacted: the cache is in memory here.
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit: () => undefined,
  });
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: DISCOVERY_PACKAGE,
      protoPath: DISCOVERY_PROTO,
      url: `127.0.0.1:${String(grpcPort)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  client = proxy.getService<Discovery>('DiscoveryService');
  closeClient = () => {
    proxy.close();
  };
});

afterAll(async () => {
  closeClient();
  await service.shutdown('test');
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as { code?: number; details?: string },
  );

describe('discovery service over gRPC', () => {
  it('is live and ready', async () => {
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
    expect((await fetch(`${http}/readyz`)).status).toBe(200);
  });

  it('serves the feed in pages', async () => {
    const all = [member(), member(), member()];
    source.set(all.map((accountId) => ({ accountId })));
    const first = await firstValueFrom(client.getFeed({ viewerAccountId: VIEWER, pageSize: 2 }));
    expect(first.outcome).toBe(FeedOutcome.FEED_OUTCOME_OK);
    expect(first.accountIds).toEqual(all.slice(0, 2));
    const second = await firstValueFrom(
      client.getFeed({ viewerAccountId: VIEWER, pageSize: 2, pageToken: first.nextPageToken }),
    );
    expect(second.accountIds).toEqual(all.slice(2));
    expect(second.nextPageToken).toBe('');
  });

  it('says why a feed is empty', async () => {
    const viewer = member();
    source.pages = [{ outcome: 'no_location', candidates: [], nextPageToken: '' }];
    const page = await firstValueFrom(client.getFeed({ viewerAccountId: viewer }));
    expect(page.outcome).toBe(FeedOutcome.FEED_OUTCOME_NO_LOCATION);
  });

  it('rejects bad input and answers UNAVAILABLE with a fixed message when a dependency is down', async () => {
    const bad = await code(firstValueFrom(client.getFeed({ viewerAccountId: 'not-an-id' })));
    expect(bad).toMatchObject({ code: status.INVALID_ARGUMENT, details: 'Invalid request.' });
    filter.down = true;
    try {
      source.set([{ accountId: member() }]);
      const down = await code(firstValueFrom(client.getFeed({ viewerAccountId: member() })));
      expect(down).toMatchObject({
        code: status.UNAVAILABLE,
        details: 'Discovery is unavailable. Try again.',
      });
    } finally {
      filter.down = false;
    }
  });
});
