/**
 * M3.2 AC: feed p95 under 300 ms at seeded scale (approved: 200,000 synthetic members, 25,000 of
 * them around Johannesburg). Real identity, profile, matching and discovery over gRPC on PostGIS,
 * in one process, so the numbers are a conservative upper bound. Run with `pnpm test:speed`.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { loadConfig } from '@chronos/config';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { generate, seed } from '@chronos/seed';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DISCOVERY_ALLOW_LIST } from '../../../services/discovery/src/allow-list.js';
import { createAppModule as discoveryModule } from '../../../services/discovery/src/app.module.js';
import { discoveryConfig } from '../../../services/discovery/src/config.js';
import { RedisFeedCache } from '../../../services/discovery/src/feed/feed-cache.js';
import { DISCOVERY_PACKAGE, DISCOVERY_PROTO } from '../../../services/discovery/src/proto.js';
import { IDENTITY_ALLOW_LIST } from '../../../services/identity/src/allow-list.js';
import { createAppModule as identityModule } from '../../../services/identity/src/app.module.js';
import { identityConfig } from '../../../services/identity/src/config.js';
import { DrizzleAccountKeyStore } from '../../../services/identity/src/crypto/account-key-store.js';
import { runMigrations as identityMigrations } from '../../../services/identity/src/db/migrate.js';
import { IDENTITY_KEY_PURPOSE } from '../../../services/identity/src/otp/otp.service.js';
import { IDENTITY_PACKAGE, IDENTITY_PROTO } from '../../../services/identity/src/proto.js';
import { RecordingOtpSender } from '../../../services/identity/test/support/otp-fakes.js';
import { MATCHING_ALLOW_LIST } from '../../../services/matching/src/allow-list.js';
import { createAppModule as matchingModule } from '../../../services/matching/src/app.module.js';
import { matchingConfig } from '../../../services/matching/src/config.js';
import { runMigrations as matchingMigrations } from '../../../services/matching/src/db/migrate.js';
import { MATCHING_PACKAGE, MATCHING_PROTO } from '../../../services/matching/src/proto.js';
import { PROFILE_ALLOW_LIST } from '../../../services/profile/src/allow-list.js';
import { createAppModule as profileModule } from '../../../services/profile/src/app.module.js';
import { profileConfig } from '../../../services/profile/src/config.js';
import { runMigrations as profileMigrations } from '../../../services/profile/src/db/migrate.js';
import { InMemoryPhotoStorage } from '../../../services/profile/src/photos/photo-storage.js';
import { PROFILE_PACKAGE, PROFILE_PROTO } from '../../../services/profile/src/proto.js';
import {
  startTestDatabase,
  type TestDatabase,
} from '../../../services/profile/test/support/database.js';

const env = loadConfig(
  z.object({
    TEST_POSTGRES_URL: z.string().optional(),
    TEST_REDIS_URL: z.string().optional(),
    SPEED_MEMBERS: z.coerce.number().int().min(1_000).default(200_000),
    SPEED_VIEWERS: z.coerce.number().int().min(10).default(200),
  }),
);
const ready = env.TEST_POSTGRES_URL !== undefined && env.TEST_REDIS_URL !== undefined;
/** The approved target (TASKS M3.2). */
const P95_TARGET_MS = 300;

const silent = createLogger({ service: 'speed', destination: { write: () => undefined } });
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

type Call<Req, Res> = (request: Req) => Observable<Res>;
interface Discovery {
  getFeed: Call<
    { viewerAccountId: string; pageSize?: number; pageToken?: string },
    { outcome: number; accountIds?: string[]; nextPageToken: string }
  >;
}
interface Profile {
  getPublicProfiles: Call<
    { viewerAccountId: string; accountIds: string[] },
    { profiles?: unknown[] }
  >;
}

let db: TestDatabase;
let redis: Redis;
const running: RunningService[] = [];
const closers: (() => void)[] = [];
let discovery: Discovery;
let profile: Profile;
let viewers: string[] = [];

async function start(
  name: string,
  options: Omit<Parameters<typeof bootstrapService>[0], 'env' | 'logger'>,
  extra: Record<string, string>,
): Promise<string> {
  const grpcPort = await freePort();
  running.push(
    await bootstrapService({
      ...options,
      logger: silent,
      env: {
        NODE_ENV: 'test',
        SERVICE_NAME: name,
        HTTP_PORT: String(await freePort()),
        GRPC_PORT: String(grpcPort),
        SHUTDOWN_DRAIN_MS: '0',
        ...extra,
      },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
      exit: () => undefined,
    }),
  );
  return `127.0.0.1:${String(grpcPort)}`;
}
function connect(pkg: string, protoPath: string, url: string): ClientGrpc {
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: { package: pkg, protoPath, url },
  }) as unknown as ClientGrpc & { close: () => void };
  closers.push(() => {
    proxy.close();
  });
  return proxy;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
function summary(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const result = {
    label,
    n: sorted.length,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
  process.stdout.write(
    `${label.padEnd(44)} n=${String(result.n)} p50=${String(result.p50)} ms p95=${String(result.p95)} ms p99=${String(result.p99)} ms max=${String(result.max)} ms\n`,
  );
  return result;
}
const time = async (run: () => Promise<unknown>) => {
  const started = performance.now();
  await run();
  return performance.now() - started;
};

beforeAll(async () => {
  if (!ready) return;
  db = await startTestDatabase();
  await identityMigrations(db.url);
  await profileMigrations(db.url);
  await matchingMigrations(db.url);
  const seeded = Date.now();
  const result = await seed(db.pool, { members: env.SPEED_MEMBERS });
  process.stdout.write(
    `Seeded ${String(result.members)} members and ${String(result.decisions)} likes and passes in ${String(Math.round((Date.now() - seeded) / 1000))} s\n`,
  );
  // Viewers: active, visible Johannesburg members with a location (the densest area).
  const { members } = generate({ members: env.SPEED_MEMBERS });
  viewers = members
    .filter((m) => m.area === 'Johannesburg' && m.active && m.visible && m.point !== null)
    .slice(0, env.SPEED_VIEWERS)
    .map((m) => m.id);

  redis = new Redis(env.TEST_REDIS_URL);
  await redis.flushdb();
  const identityAt = await start(
    'identity',
    {
      module: identityModule({
        sender: new RecordingOtpSender(),
        keyring: new SubjectKeyring({
          wrapper: new InMemoryKeyWrapper(),
          store: new DrizzleAccountKeyStore(drizzle(db.pool)),
          purpose: IDENTITY_KEY_PURPOSE,
          cacheTtlMs: 0,
        }),
      }),
      extraConfig: identityConfig,
      grpc: { packageName: IDENTITY_PACKAGE, protoPath: IDENTITY_PROTO },
      allowList: IDENTITY_ALLOW_LIST,
    },
    {
      DATABASE_URL: db.url,
      REDIS_URL: env.TEST_REDIS_URL,
      IDENTITY_DATA_KEY_ID: 'alias/synthetic',
      PHONE_LOOKUP_KEY: randomBytes(32).toString('base64'),
      OTP_CODE_KEY: randomBytes(32).toString('base64'),
    },
  );
  const matchingAt = await start(
    'matching',
    {
      module: matchingModule(),
      extraConfig: matchingConfig,
      grpc: { packageName: MATCHING_PACKAGE, protoPath: MATCHING_PROTO },
      allowList: MATCHING_ALLOW_LIST,
    },
    { DATABASE_URL: db.url },
  );
  const profileAt = await start(
    'profile',
    {
      module: profileModule({ photoStorage: new InMemoryPhotoStorage() }),
      extraConfig: profileConfig,
      grpc: { packageName: PROFILE_PACKAGE, protoPath: PROFILE_PROTO },
      allowList: PROFILE_ALLOW_LIST,
    },
    { DATABASE_URL: db.url, IDENTITY_GRPC_ADDRESS: identityAt, MATCHING_GRPC_ADDRESS: matchingAt },
  );
  const discoveryAt = await start(
    'discovery',
    {
      module: discoveryModule({ cache: new RedisFeedCache(redis) }),
      extraConfig: discoveryConfig,
      grpc: { packageName: DISCOVERY_PACKAGE, protoPath: DISCOVERY_PROTO },
      allowList: DISCOVERY_ALLOW_LIST,
    },
    {
      REDIS_URL: env.TEST_REDIS_URL,
      PROFILE_GRPC_ADDRESS: profileAt,
      MATCHING_GRPC_ADDRESS: matchingAt,
    },
  );
  discovery = connect(DISCOVERY_PACKAGE, DISCOVERY_PROTO, discoveryAt).getService<Discovery>(
    'DiscoveryService',
  );
  profile = connect(PROFILE_PACKAGE, PROFILE_PROTO, profileAt).getService<Profile>(
    'ProfileService',
  );
}, 900_000);

afterAll(async () => {
  if (!ready) return;
  for (const close of closers) close();
  for (const service of running.reverse()) await service.shutdown('test');
  await redis.flushdb();
  await redis.quit();
  await db.stop();
});

/** What the gateway does for one page: the ids from discovery, then the cards from profile. */
async function feedPage(viewerAccountId: string, pageToken = '') {
  const page = await firstValueFrom(
    discovery.getFeed({ viewerAccountId, pageSize: 20, pageToken }),
  );
  const ids = page.accountIds ?? [];
  if (ids.length > 0) {
    await firstValueFrom(profile.getPublicProfiles({ viewerAccountId, accountIds: ids }));
  }
  return page;
}

describe.skipIf(!ready)('M3.2 speed: feed p95 under 300 ms at seeded scale', () => {
  it('builds and serves feeds for Johannesburg members within the target', async () => {
    expect(viewers.length).toBeGreaterThanOrEqual(10);
    // Warm the connections and the database caches with members outside the measured set.
    const { members } = generate({ members: env.SPEED_MEMBERS });
    const warmers = members
      .filter((m) => m.area === 'Ekurhuleni' && m.active && m.visible && m.point !== null)
      .slice(0, 20);
    for (const m of warmers) await feedPage(m.id);

    const cold: number[] = [];
    const tokens = new Map<string, string>();
    const sizes: number[] = [];
    for (const viewer of viewers) {
      let page: Awaited<ReturnType<typeof feedPage>> | undefined;
      cold.push(
        await time(async () => {
          page = await feedPage(viewer);
        }),
      );
      sizes.push(page?.accountIds?.length ?? 0);
      if (page?.nextPageToken) tokens.set(viewer, page.nextPageToken);
    }
    const warm: number[] = [];
    for (const [viewer, token] of tokens) warm.push(await time(() => feedPage(viewer, token)));

    // Eight members at once, each building a new feed.
    await redis.flushdb();
    const concurrent: number[] = [];
    const queue = [...viewers];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let viewer = queue.shift(); viewer; viewer = queue.shift()) {
          concurrent.push(await time(() => feedPage(viewer)));
        }
      }),
    );

    const first = summary('first page (feed built, with cards)', cold);
    const next = summary('next page (feed kept, with cards)', warm);
    const busy = summary('first page, 8 members at once', concurrent);
    const empty = sizes.filter((s) => s === 0).length;
    process.stdout.write(
      `Cards on the first page: median ${String([...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0)} of 20; empty feeds ${String(empty)} of ${String(sizes.length)}\n`,
    );

    expect(first.p95).toBeLessThan(P95_TARGET_MS);
    expect(next.p95).toBeLessThan(P95_TARGET_MS);
    // Reported, not asserted: all four services share one event loop here.
    expect(busy.n).toBe(viewers.length);
    // The feed is worth measuring only if it has people in it.
    expect(empty).toBeLessThan(sizes.length / 10);
  }, 900_000);
});
