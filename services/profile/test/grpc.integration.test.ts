import { createServer } from 'node:net';
import { CandidatesOutcome, Intent } from '@chronos/contracts/profile';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { status } from '@grpc/grpc-js';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppModule } from '../src/app.module.js';
import { profileConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { PROFILE_PACKAGE, PROFILE_PROTO } from '../src/proto.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { FakeBlocks, FakeMemberFacts } from './support/profile-fakes.js';

type Call<Req, Res> = (request: Req) => Observable<Res>;
interface Own {
  profile: {
    accountId: string;
    displayName: string;
    bio: string;
    intent: number;
    pronouns: string;
    privateMode: boolean;
    visible: boolean;
    prompts?: { promptId: string; answer: string }[];
    interests?: string[];
    hasLocation: boolean;
  };
  preferences: { ageMin: number; ageMax: number; maxDistanceKm: number; intents?: number[] };
}
interface ProfileClient {
  getOwnProfile: Call<{ accountId: string }, Own>;
  updateProfile: Call<Record<string, unknown>, Own>;
  updatePreferences: Call<Record<string, unknown>, Own>;
  getCatalogue: Call<object, { prompts: { id: string }[]; interests: { id: string }[] }>;
  setLocation: Call<Record<string, unknown>, Own>;
  getPublicProfiles: Call<
    { viewerAccountId: string; accountIds: string[] },
    { profiles?: Record<string, unknown>[] }
  >;
  findCandidates: Call<
    { viewerAccountId: string; pageSize?: number; pageToken?: string },
    {
      outcome: number;
      candidates?: { accountId: string; privateMode: boolean }[];
      nextPageToken: string;
    }
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

let db: TestDatabase;
let service: RunningService;
let client: ProfileClient;
let http: string;
let closeClient: () => void;
const MEMBER = '77777777-7777-4777-8777-777777777777';
const OTHER = '77777777-7777-4777-8777-777777777778';
const facts = new FakeMemberFacts();
const blocks = new FakeBlocks();

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  const grpcPort = await freePort();
  const httpPort = await freePort();
  http = `http://127.0.0.1:${String(httpPort)}`;
  service = await bootstrapService({
    module: createAppModule({ facts, visibility: blocks }),
    extraConfig: profileConfig,
    grpc: { packageName: PROFILE_PACKAGE, protoPath: PROFILE_PROTO },
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'profile',
      HTTP_PORT: String(httpPort),
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
      package: PROFILE_PACKAGE,
      protoPath: PROFILE_PROTO,
      url: `127.0.0.1:${String(grpcPort)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  client = proxy.getService<ProfileClient>('ProfileService');
  closeClient = () => {
    proxy.close();
  };
});

afterAll(async () => {
  closeClient();
  await service.shutdown('test');
  await db.stop();
});

const call = firstValueFrom;

async function grpcError(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: number; details?: string } | undefined;
  return { code: error?.code, details: error?.details };
}

describe('profile gRPC API', () => {
  it('is live and ready with its database', async () => {
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
    expect((await fetch(`${http}/readyz`)).status).toBe(200);
  });

  it('answers NOT_FOUND with a fixed message before a profile exists', async () => {
    expect(await grpcError(call(client.getOwnProfile({ accountId: MEMBER })))).toEqual({
      code: status.NOT_FOUND,
      details: 'Create your profile first.',
    });
  });

  it('creates, then changes only the fields sent', async () => {
    const created = await call(
      client.updateProfile({
        accountId: MEMBER,
        displayName: 'Thandi',
        intent: Intent.INTENT_FRIENDSHIP,
        bio: 'Hello there',
        prompts: { items: [{ promptId: 'laugh', answer: 'Dad jokes' }] },
        interests: { ids: ['jazz', 'hiking'] },
      }),
    );
    expect(created.profile).toMatchObject({
      displayName: 'Thandi',
      intent: Intent.INTENT_FRIENDSHIP,
      bio: 'Hello there',
      prompts: [{ promptId: 'laugh', answer: 'Dad jokes' }],
      interests: ['hiking', 'jazz'],
      hasLocation: false,
      visible: true,
    });

    // Only pronouns and an explicitly empty bio are sent; prompts and interests are not.
    const changed = await call(
      client.updateProfile({ accountId: MEMBER, pronouns: 'she/her', bio: '' }),
    );
    expect(changed.profile).toMatchObject({
      displayName: 'Thandi',
      intent: Intent.INTENT_FRIENDSHIP,
      pronouns: 'she/her',
      bio: '',
      prompts: [{ promptId: 'laugh', answer: 'Dad jokes' }],
      interests: ['hiking', 'jazz'],
    });

    // An empty interest list clears them.
    const cleared = await call(client.updateProfile({ accountId: MEMBER, interests: { ids: [] } }));
    expect(cleared.profile.interests ?? []).toEqual([]);
  });

  it('updates preferences and refuses ages under 18', async () => {
    const { preferences } = await call(
      client.updatePreferences({
        accountId: MEMBER,
        ageMin: 25,
        intents: { values: [Intent.INTENT_DATING, Intent.INTENT_OPEN] },
      }),
    );
    expect(preferences).toMatchObject({
      ageMin: 25,
      ageMax: 99,
      maxDistanceKm: 50,
      intents: [Intent.INTENT_DATING, Intent.INTENT_OPEN],
    });
    expect(
      (await grpcError(call(client.updatePreferences({ accountId: MEMBER, ageMin: 17 })))).code,
    ).toBe(status.INVALID_ARGUMENT);
  });

  it('rejects malformed requests without echoing them', async () => {
    const bad = await grpcError(
      call(client.updateProfile({ accountId: 'not-a-uuid', displayName: 'Thandi' })),
    );
    expect(bad).toEqual({ code: status.INVALID_ARGUMENT, details: 'Invalid request.' });
    const unknownIntent = await grpcError(
      call(client.updateProfile({ accountId: MEMBER, intent: 42 })),
    );
    expect(unknownIntent.code).toBe(status.INVALID_ARGUMENT);
  });

  it('finds candidates over gRPC with an opaque page token (M3.2)', async () => {
    const viewer = '77777777-7777-4777-8777-7777777777a1';
    const near = '77777777-7777-4777-8777-7777777777a2';
    const alsoNear = '77777777-7777-4777-8777-7777777777a3';
    for (const id of [viewer, near, alsoNear]) {
      facts.facts.set(id, { age: 33, verified: false });
      await call(
        client.updateProfile({
          accountId: id,
          displayName: 'Member',
          intent: Intent.INTENT_DATING,
        }),
      );
    }
    expect((await call(client.findCandidates({ viewerAccountId: viewer }))).outcome).toBe(
      CandidatesOutcome.CANDIDATES_OUTCOME_NO_LOCATION,
    );
    // Somewhere none of the other tests put anyone.
    for (const id of [viewer, near, alsoNear]) {
      await call(client.setLocation({ accountId: id, latitude: -30.5, longitude: 22.0 }));
    }
    const first = await call(client.findCandidates({ viewerAccountId: viewer, pageSize: 1 }));
    expect(first.outcome).toBe(CandidatesOutcome.CANDIDATES_OUTCOME_OK);
    expect(first.candidates).toHaveLength(1);
    const second = await call(
      client.findCandidates({
        viewerAccountId: viewer,
        pageSize: 1,
        pageToken: first.nextPageToken,
      }),
    );
    expect(
      [...(first.candidates ?? []), ...(second.candidates ?? [])].map((c) => c.accountId).sort(),
    ).toEqual([near, alsoNear].sort());
    const bad = await call(
      client.findCandidates({ viewerAccountId: viewer, pageToken: 'not-a-token' }),
    ).then(
      () => undefined,
      (e: unknown) => (e as { code?: number }).code,
    );
    expect(bad).toBe(status.INVALID_ARGUMENT);
  });

  it('never shows members blocked either way (M3.1 AC)', async () => {
    facts.facts.set(OTHER, { age: 31, verified: true });
    await call(
      client.updateProfile({
        accountId: OTHER,
        displayName: 'Bongani',
        intent: Intent.INTENT_DATING,
      }),
    );
    const ask = () =>
      call(client.getPublicProfiles({ viewerAccountId: MEMBER, accountIds: [OTHER] }));
    expect((await ask()).profiles).toHaveLength(1);
    blocks.pairs.add(FakeBlocks.key(OTHER, MEMBER));
    try {
      expect((await ask()).profiles ?? []).toEqual([]);
      const reverse = await call(
        client.getPublicProfiles({ viewerAccountId: OTHER, accountIds: [MEMBER] }),
      );
      expect(reverse.profiles ?? []).toEqual([]);
    } finally {
      blocks.pairs.clear();
    }
  });

  it('serves the catalogue', async () => {
    const { prompts, interests } = await call(client.getCatalogue({}));
    expect(prompts.length).toBeGreaterThan(0);
    expect(interests.map((i) => i.id)).toContain('hiking');
  });

  it('snaps locations and shows other members only a rounded distance (M1.5 AC)', async () => {
    facts.facts.set(OTHER, { age: 31, verified: true });
    await call(
      client.updateProfile({
        accountId: OTHER,
        displayName: 'Bongani',
        intent: Intent.INTENT_DATING,
      }),
    );
    const set = await call(
      client.setLocation({ accountId: MEMBER, latitude: -26.204123, longitude: 28.047349 }),
    );
    expect(set.profile.hasLocation).toBe(true);
    await call(
      client.setLocation({ accountId: OTHER, latitude: -25.747912, longitude: 28.229271 }),
    );

    const { profiles } = await call(
      client.getPublicProfiles({ viewerAccountId: MEMBER, accountIds: [OTHER, MEMBER] }),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles?.[0]).toMatchObject({
      accountId: OTHER,
      displayName: 'Bongani',
      age: 31,
      verified: true,
      distanceKm: 55,
    });
    const text = JSON.stringify(profiles);
    for (const digits of ['26.2', '28.04', '28.05', '25.74', '25.75', '28.22', '28.23']) {
      expect(text).not.toContain(digits);
    }

    const cleared = await call(client.setLocation({ accountId: MEMBER, clear: true }));
    expect(cleared.profile.hasLocation).toBe(false);
    const after = await call(
      client.getPublicProfiles({ viewerAccountId: MEMBER, accountIds: [OTHER] }),
    );
    expect(after.profiles?.[0]?.['distanceKm']).toBeUndefined();
  });

  it('rejects a position that is not real', async () => {
    const bad = await grpcError(
      call(client.setLocation({ accountId: MEMBER, latitude: 95, longitude: 10 })),
    );
    expect(bad).toEqual({
      code: status.INVALID_ARGUMENT,
      details: 'That location could not be used.',
    });
  });
});
