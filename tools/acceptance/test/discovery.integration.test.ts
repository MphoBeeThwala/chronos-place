/**
 * M3.2 acceptance: the real profile, matching and discovery services over gRPC, as in production
 * (ADR-0026). Members are placed and filtered for real in PostGIS; only identity's ages are faked.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { FeedOutcome } from '@chronos/contracts/discovery';
import { Intent } from '@chronos/contracts/profile';
import { createLogger } from '@chronos/logger';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCOVERY_ALLOW_LIST } from '../../../services/discovery/src/allow-list.js';
import { createAppModule as discoveryModule } from '../../../services/discovery/src/app.module.js';
import { discoveryConfig } from '../../../services/discovery/src/config.js';
import { InMemoryFeedCache } from '../../../services/discovery/src/feed/feed-cache.js';
import { DISCOVERY_PACKAGE, DISCOVERY_PROTO } from '../../../services/discovery/src/proto.js';
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
import { FakeMemberFacts } from '../../../services/profile/test/support/profile-fakes.js';

/** The vault's answer for a member with no condition filters (M3.4). */
const NO_FILTERS = {
  eligible: () => Promise.resolve({ outcome: 'no_preferences' as const }),
};
const silent = createLogger({ service: 'acceptance', destination: { write: () => undefined } });

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

type Call<Req, Res = object> = (request: Req) => Observable<Res>;
interface Profile {
  updateProfile: Call<Record<string, unknown>>;
  updatePreferences: Call<Record<string, unknown>>;
  setLocation: Call<Record<string, unknown>>;
}
interface Matching {
  like: Call<{ fromAccountId: string; toAccountId: string }>;
  pass: Call<{ fromAccountId: string; toAccountId: string }>;
  block: Call<{ blockerAccountId: string; blockedAccountId: string }>;
}
interface Discovery {
  getFeed: Call<
    { viewerAccountId: string; pageSize?: number },
    { outcome: number; accountIds?: string[]; nextPageToken: string }
  >;
}

let db: TestDatabase;
const running: RunningService[] = [];
const closers: (() => void)[] = [];
const facts = new FakeMemberFacts();
let profile: Profile;
let matching: Matching;
let discovery: Discovery;

async function start(
  name: string,
  options: Omit<Parameters<typeof bootstrapService>[0], 'env' | 'logger'>,
  env: Record<string, string>,
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
        ...env,
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

beforeAll(async () => {
  db = await startTestDatabase();
  await profileMigrations(db.url);
  await matchingMigrations(db.url);
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
      module: profileModule({ facts, photoStorage: new InMemoryPhotoStorage() }),
      extraConfig: profileConfig,
      grpc: { packageName: PROFILE_PACKAGE, protoPath: PROFILE_PROTO },
      allowList: PROFILE_ALLOW_LIST,
    },
    { DATABASE_URL: db.url, MATCHING_GRPC_ADDRESS: matchingAt },
  );
  const discoveryAt = await start(
    'discovery',
    {
      // The vault runs in restricted/, which this package may not import: its filter is tested
      // there (filter.grpc.integration). Here, nobody has condition filters.
      module: discoveryModule({ cache: new InMemoryFeedCache(), conditions: NO_FILTERS }),
      extraConfig: discoveryConfig,
      grpc: { packageName: DISCOVERY_PACKAGE, protoPath: DISCOVERY_PROTO },
      allowList: DISCOVERY_ALLOW_LIST,
    },
    {
      REDIS_URL: 'redis://127.0.0.1:1',
      PROFILE_GRPC_ADDRESS: profileAt,
      MATCHING_GRPC_ADDRESS: matchingAt,
    },
  );
  profile = connect(PROFILE_PACKAGE, PROFILE_PROTO, profileAt).getService<Profile>(
    'ProfileService',
  );
  matching = connect(MATCHING_PACKAGE, MATCHING_PROTO, matchingAt).getService<Matching>(
    'MatchingService',
  );
  discovery = connect(DISCOVERY_PACKAGE, DISCOVERY_PROTO, discoveryAt).getService<Discovery>(
    'DiscoveryService',
  );
}, 120_000);

afterAll(async () => {
  for (const close of closers) close();
  for (const service of running.reverse()) await service.shutdown('test');
  await db.stop();
});

const SOWETO = { latitude: -26.27, longitude: 27.86 };
const NEARBY = { latitude: -26.25, longitude: 27.9 };
const FURTHER = { latitude: -26.2, longitude: 27.98 };
const DURBAN = { latitude: -29.86, longitude: 31.02 };

async function member(
  where: typeof SOWETO | null,
  options: { age?: number; privateMode?: boolean; ageMax?: number } = {},
): Promise<string> {
  const id = randomUUID();
  facts.facts.set(id, { age: options.age ?? 30, verified: false });
  await firstValueFrom(
    profile.updateProfile({
      accountId: id,
      displayName: 'Synthetic member',
      intent: Intent.INTENT_DATING,
      ...(options.privateMode === true ? { privateMode: true } : {}),
    }),
  );
  if (options.ageMax !== undefined) {
    await firstValueFrom(profile.updatePreferences({ accountId: id, ageMax: options.ageMax }));
  }
  if (where) await firstValueFrom(profile.setLocation({ accountId: id, ...where }));
  return id;
}
const feed = (viewerAccountId: string) =>
  firstValueFrom(discovery.getFeed({ viewerAccountId, pageSize: 50 }));

describe('M3.2 acceptance: geo, age and intent filters with every exclusion', () => {
  it('asks a member without a location to share one', async () => {
    const viewer = await member(null);
    expect((await feed(viewer)).outcome).toBe(FeedOutcome.FEED_OUTCOME_NO_LOCATION);
  });

  it('offers nearby fitting members, nearest first, and never the excluded ones', async () => {
    const viewer = await member(SOWETO, { age: 34 });
    const closest = await member(SOWETO);
    const near = await member(NEARBY);
    const far = await member(DURBAN);
    const wantsYounger = await member(SOWETO, { ageMax: 30 });
    const tooOld = await member(SOWETO, { age: 99 });
    await firstValueFrom(profile.updatePreferences({ accountId: viewer, ageMax: 60 }));
    const liked = await member(SOWETO);
    const passed = await member(SOWETO);
    const blocker = await member(SOWETO);
    const shy = await member(SOWETO, { privateMode: true });
    const shyLiker = await member(FURTHER, { privateMode: true });
    await firstValueFrom(matching.like({ fromAccountId: viewer, toAccountId: liked }));
    await firstValueFrom(matching.pass({ fromAccountId: viewer, toAccountId: passed }));
    await firstValueFrom(matching.block({ blockerAccountId: blocker, blockedAccountId: viewer }));
    await firstValueFrom(matching.like({ fromAccountId: shyLiker, toAccountId: viewer }));

    const page = await feed(viewer);
    expect(page.outcome).toBe(FeedOutcome.FEED_OUTCOME_OK);
    const ids = page.accountIds ?? [];
    expect(ids.filter((id) => [closest, near, shyLiker].includes(id))).toEqual([
      closest,
      near,
      shyLiker,
    ]);
    for (const left of [far, wantsYounger, tooOld, liked, passed, blocker, shy, viewer]) {
      expect(ids).not.toContain(left);
    }
  });

  it('applies a block made after the feed was built, at once', async () => {
    const viewer = await member(DURBAN);
    const other = await member(DURBAN);
    expect((await feed(viewer)).accountIds).toContain(other);
    await firstValueFrom(matching.block({ blockerAccountId: other, blockedAccountId: viewer }));
    expect((await feed(viewer)).accountIds ?? []).not.toContain(other);
  });
});
