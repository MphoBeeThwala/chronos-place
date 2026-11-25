import { createServer } from 'node:net';
import { Intent, PhotoModeration } from '@chronos/contracts/profile';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { status } from '@grpc/grpc-js';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppModule } from '../src/app.module.js';
import { profileConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { PROFILE_PACKAGE, PROFILE_PROTO } from '../src/proto.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { hasGps } from './support/exif.js';
import { FakeMemberFacts } from './support/profile-fakes.js';
import { startTestS3, type TestS3 } from './support/s3.js';

/**
 * The whole photo path through the running service, real PostgreSQL and real S3 storage
 * (SeaweedFS): signed link, browser-style PUT, completion, re-encoded sizes, view links.
 */
type Call<Req, Res> = (request: Req) => Observable<Res>;
interface WirePhoto {
  id: string;
  position: number;
  moderation: number;
  variants?: { size: number; url: string }[];
  width: number;
  height: number;
}
interface Client {
  updateProfile: Call<Record<string, unknown>, object>;
  createPhotoUpload: Call<
    { accountId: string; contentType: string; byteLength: number },
    { uploadId: string; uploadUrl: string; expiresAt: unknown }
  >;
  completePhotoUpload: Call<{ accountId: string; uploadId: string }, { photo: WirePhoto }>;
  listOwnPhotos: Call<{ accountId: string }, { photos?: WirePhoto[] }>;
  reorderPhotos: Call<{ accountId: string; photoIds: string[] }, { photos?: WirePhoto[] }>;
  deletePhoto: Call<{ accountId: string; photoId: string }, { photos?: WirePhoto[] }>;
  getPublicProfiles: Call<
    { viewerAccountId: string; accountIds: string[] },
    { profiles?: { accountId: string; photos?: WirePhoto[] }[] }
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

const MEMBER = '88888888-8888-4888-8888-888888888881';
const VIEWER = '88888888-8888-4888-8888-888888888882';
const call = firstValueFrom;
let db: TestDatabase;
let s3: TestS3;
let service: RunningService;
let client: Client;
let closeClient: () => void;
// Identity's facts: only active members appear in public profiles.
const facts = new FakeMemberFacts();
facts.facts.set(MEMBER, { age: 29, verified: false });

/** Synthetic phone photo with a made-up GPS block (CLAUDE.md rule 6). */
const phonePhoto = () =>
  sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#88aacc' } })
    .withExif({
      IFD0: { Make: 'SynthCam' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '26/1 12/1 1440/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '28/1 2/1 4800/100',
      },
    })
    .jpeg()
    .toBuffer();

async function grpcCode(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: number } | undefined;
  return error?.code;
}

async function upload(accountId: string) {
  const body = await phonePhoto();
  const { uploadId, uploadUrl } = await call(
    client.createPhotoUpload({ accountId, contentType: 'image/jpeg', byteLength: body.length }),
  );
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body,
  });
  expect(put.ok).toBe(true);
  return { body, uploadId };
}

beforeAll(async () => {
  [db, s3] = await Promise.all([startTestDatabase(), startTestS3()]);
  await runMigrations(db.url);
  const grpcPort = await freePort();
  const httpPort = await freePort();
  service = await bootstrapService({
    module: createAppModule({ facts }),
    extraConfig: profileConfig,
    grpc: { packageName: PROFILE_PACKAGE, protoPath: PROFILE_PROTO },
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'profile',
      HTTP_PORT: String(httpPort),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      DATABASE_URL: db.url,
      PHOTO_UPLOAD_BUCKET: s3.uploadBucket,
      PHOTO_MEDIA_BUCKET: s3.mediaBucket,
      S3_ENDPOINT: s3.endpoint,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
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
  client = proxy.getService<Client>('ProfileService');
  closeClient = () => {
    proxy.close();
  };
  for (const accountId of [MEMBER, VIEWER]) {
    await call(
      client.updateProfile({ accountId, displayName: 'Ayanda', intent: Intent.INTENT_DATING }),
    );
  }
}, 120_000);

afterAll(async () => {
  closeClient();
  await service.shutdown('test');
  await Promise.all([db.stop(), s3.stop()]);
});

describe('photos over gRPC with S3 storage (M1.6)', () => {
  it('turns an upload into three sizes without GPS, visible to others once approved', async () => {
    const { body, uploadId } = await upload(MEMBER);
    expect(hasGps(body)).toBe(true);

    const { photo } = await call(client.completePhotoUpload({ accountId: MEMBER, uploadId }));
    // The test environment auto-approves (ADR-0024 decision e).
    expect(photo.moderation).toBe(PhotoModeration.PHOTO_MODERATION_APPROVED);
    expect(photo.variants?.map((v) => v.size)).toEqual([320, 640, 1280]);

    for (const variant of photo.variants ?? []) {
      const response = await fetch(variant.url);
      expect(response.ok).toBe(true);
      const stored = Buffer.from(await response.arrayBuffer());
      expect(hasGps(stored)).toBe(false);
      expect(stored.includes('SynthCam')).toBe(false);
      const meta = await sharp(stored).metadata();
      expect([meta.format, Math.max(meta.width, meta.height)]).toEqual(['webp', variant.size]);
    }

    // The upload link is single use: completing again finds nothing.
    expect(await grpcCode(call(client.completePhotoUpload({ accountId: MEMBER, uploadId })))).toBe(
      status.NOT_FOUND,
    );

    const { profiles } = await call(
      client.getPublicProfiles({ viewerAccountId: VIEWER, accountIds: [MEMBER] }),
    );
    expect(profiles?.[0]?.photos?.map((p) => p.id)).toEqual([photo.id]);
  });

  it('reorders and deletes, and the deleted sizes can no longer be fetched', async () => {
    const { uploadId } = await upload(MEMBER);
    const { photo: second } = await call(
      client.completePhotoUpload({ accountId: MEMBER, uploadId }),
    );
    const { photos: before } = await call(client.listOwnPhotos({ accountId: MEMBER }));
    const first = before?.[0];
    expect(before?.map((p) => p.id)).toEqual([first?.id, second.id]);

    const { photos: reordered } = await call(
      client.reorderPhotos({ accountId: MEMBER, photoIds: [second.id, first?.id ?? ''] }),
    );
    expect(reordered?.map((p) => [p.id, p.position])).toEqual([
      [second.id, 0],
      [first?.id, 1],
    ]);

    const oldUrl = second.variants?.[0]?.url ?? '';
    const { photos: after } = await call(
      client.deletePhoto({ accountId: MEMBER, photoId: second.id }),
    );
    expect(after?.map((p) => [p.id, p.position])).toEqual([[first?.id, 0]]);
    expect((await fetch(oldUrl)).ok).toBe(false);
  });

  it('refuses bad requests with fixed codes', async () => {
    expect(
      await grpcCode(
        call(
          client.createPhotoUpload({ accountId: MEMBER, contentType: 'image/gif', byteLength: 10 }),
        ),
      ),
    ).toBe(status.INVALID_ARGUMENT);
    expect(
      await grpcCode(
        call(
          client.deletePhoto({
            accountId: VIEWER,
            photoId: '88888888-8888-4888-8888-000000000000',
          }),
        ),
      ),
    ).toBe(status.NOT_FOUND);
    expect(await grpcCode(call(client.listOwnPhotos({ accountId: 'not-a-uuid' })))).toBe(
      status.INVALID_ARGUMENT,
    );
  });
});
