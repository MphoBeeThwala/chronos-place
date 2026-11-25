import { createServer } from 'node:net';
import { Intent } from '@chronos/contracts/profile';
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

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  const grpcPort = await freePort();
  const httpPort = await freePort();
  http = `http://127.0.0.1:${String(httpPort)}`;
  service = await bootstrapService({
    module: createAppModule(),
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

  it('serves the catalogue', async () => {
    const { prompts, interests } = await call(client.getCatalogue({}));
    expect(prompts.length).toBeGreaterThan(0);
    expect(interests.map((i) => i.id)).toContain('hiking');
  });
});
