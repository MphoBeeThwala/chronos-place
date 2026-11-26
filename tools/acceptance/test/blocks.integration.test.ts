/**
 * M3.1 acceptance: blocks hide both members from each other everywhere. The real matching service
 * runs over gRPC and the real profile runtime asks it, as in production. The Disclosure Service's
 * side (restricted/, which this package may not import) is tested against the same contract there.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createLogger } from '@chronos/logger';
import {
  bootstrapService,
  ReadinessRegistry,
  serviceConfigSchema,
  type RunningService,
} from '@chronos/service-kit';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATCHING_ALLOW_LIST } from '../../../services/matching/src/allow-list.js';
import { createAppModule as matchingModule } from '../../../services/matching/src/app.module.js';
import { matchingConfig } from '../../../services/matching/src/config.js';
import { runMigrations as matchingMigrations } from '../../../services/matching/src/db/migrate.js';
import { MATCHING_PACKAGE, MATCHING_PROTO } from '../../../services/matching/src/proto.js';
import { profileConfig } from '../../../services/profile/src/config.js';
import { runMigrations as profileMigrations } from '../../../services/profile/src/db/migrate.js';
import { InMemoryPhotoStorage } from '../../../services/profile/src/photos/photo-storage.js';
import {
  createProfileRuntime,
  type ProfileRuntime,
} from '../../../services/profile/src/runtime.js';
import {
  startTestDatabase,
  type TestDatabase,
} from '../../../services/profile/test/support/database.js';
import { FakeMemberFacts } from '../../../services/profile/test/support/profile-fakes.js';

const silent = createLogger({ service: 'acceptance', destination: { write: () => undefined } });

type Call<Req, Res> = (request: Req) => Observable<Res>;
interface Matching {
  like: Call<{ fromAccountId: string; toAccountId: string }, { matched: boolean }>;
  block: Call<{ blockerAccountId: string; blockedAccountId: string }, object>;
  unblock: Call<{ blockerAccountId: string; blockedAccountId: string }, object>;
  getRelationship: Call<
    { accountId: string; otherAccountId: string },
    { blocked: boolean; activeMatchId: string }
  >;
  listMatches: Call<{ accountId: string }, { matches?: unknown[] }>;
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

let db: TestDatabase;
let matching: RunningService;
let matchingClient: Matching;
let closeClient: () => void;
let profile: ProfileRuntime;
const facts = new FakeMemberFacts();

beforeAll(async () => {
  db = await startTestDatabase();
  await profileMigrations(db.url);
  await matchingMigrations(db.url);
  const grpcPort = await freePort();
  matching = await bootstrapService({
    module: matchingModule(),
    extraConfig: matchingConfig,
    grpc: { packageName: MATCHING_PACKAGE, protoPath: MATCHING_PROTO },
    allowList: MATCHING_ALLOW_LIST,
    logger: silent,
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'matching',
      HTTP_PORT: String(await freePort()),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      DATABASE_URL: db.url,
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
  matchingClient = proxy.getService<Matching>('MatchingService');
  closeClient = () => {
    proxy.close();
  };
  profile = createProfileRuntime(
    serviceConfigSchema(profileConfig).parse({
      NODE_ENV: 'test',
      SERVICE_NAME: 'profile',
      DATABASE_URL: db.url,
      MATCHING_GRPC_ADDRESS: `127.0.0.1:${String(grpcPort)}`,
    }),
    silent,
    new ReadinessRegistry(),
    { facts, photoStorage: new InMemoryPhotoStorage() },
  );
}, 120_000);

afterAll(async () => {
  closeClient();
  await profile.close();
  await matching.shutdown('test');
  await db.stop();
});

async function member(name: string): Promise<string> {
  const id = randomUUID();
  facts.facts.set(id, { age: 30, verified: true });
  await profile.profiles.update(id, { displayName: name, intent: 'dating' });
  return id;
}
const sees = async (viewer: string, other: string) =>
  (await profile.profiles.publicProfiles(viewer, [other])).map((p) => p.accountId);
const relationship = (accountId: string, otherAccountId: string) =>
  firstValueFrom(matchingClient.getRelationship({ accountId, otherAccountId }));

describe('M3.1 acceptance: a block hides both members from each other everywhere', () => {
  it('ends the match and hides each profile from the other, both ways', async () => {
    const [ayanda, lerato, bystander] = [
      await member('Ayanda'),
      await member('Lerato'),
      await member('Sipho'),
    ];
    await firstValueFrom(matchingClient.like({ fromAccountId: ayanda, toAccountId: lerato }));
    expect(
      (await firstValueFrom(matchingClient.like({ fromAccountId: lerato, toAccountId: ayanda })))
        .matched,
    ).toBe(true);
    expect(await sees(ayanda, lerato)).toEqual([lerato]);

    await firstValueFrom(
      matchingClient.block({ blockerAccountId: lerato, blockedAccountId: ayanda }),
    );

    // Profiles: hidden both ways; everyone else still visible.
    expect(await sees(ayanda, lerato)).toEqual([]);
    expect(await sees(lerato, ayanda)).toEqual([]);
    expect(await sees(ayanda, bystander)).toEqual([bystander]);
    // Matches and the relationship the Disclosure Service and messaging ask about.
    expect(await relationship(ayanda, lerato)).toEqual({ blocked: true, activeMatchId: '' });
    expect(await relationship(lerato, ayanda)).toEqual({ blocked: true, activeMatchId: '' });
    expect(
      (await firstValueFrom(matchingClient.listMatches({ accountId: ayanda }))).matches ?? [],
    ).toEqual([]);
  });

  it('hides everyone when matching cannot be reached (fail closed)', async () => {
    const unreachable = createProfileRuntime(
      serviceConfigSchema(profileConfig).parse({
        NODE_ENV: 'test',
        SERVICE_NAME: 'profile',
        DATABASE_URL: db.url,
        MATCHING_GRPC_ADDRESS: '127.0.0.1:1',
      }),
      silent,
      new ReadinessRegistry(),
      { facts, photoStorage: new InMemoryPhotoStorage() },
    );
    try {
      const [a, b] = [await member('Thabo'), await member('Zanele')];
      expect(await unreachable.profiles.publicProfiles(a, [b])).toEqual([]);
    } finally {
      await unreachable.close();
    }
  });
});
