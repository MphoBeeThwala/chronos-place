import { Intent, PhotoModeration } from '@chronos/contracts/profile';
import { createLogger } from '@chronos/logger';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const identity = new FakeIdentity();
const profile = new FakeProfile();
let gateway: TestGateway;
let n = 0;
const member = () => {
  n += 1;
  const id = `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  return id;
};
const session = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });

const PHOTO_ID = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const UPLOAD_ID = 'eeeeeeee-eeee-4eee-8eee-000000000001';
const wirePhoto = (
  id = PHOTO_ID,
  position = 0,
  moderation = PhotoModeration.PHOTO_MODERATION_PENDING,
) => ({
  id,
  position,
  moderation,
  width: 1600,
  height: 1200,
  variants: [320, 640, 1280].map((size) => ({
    size,
    url: `https://media.test/photos/${id}/${String(size)}.webp?sig=x`,
  })),
});
const own = (accountId: string) => ({
  profile: {
    accountId,
    displayName: 'Zinhle',
    bio: '',
    intent: Intent.INTENT_DATING,
    gender: '',
    pronouns: '',
    areaLabel: '',
    privateMode: false,
    visible: true,
    hasLocation: false,
  },
  preferences: { ageMin: 25, ageMax: 40, maxDistanceKm: 50 },
});

const PHOTO_FIELDS = 'id position url width height status variants { size url }';

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start()]);
  gateway = await startGateway(identity, {
    profile,
    logger: createLogger({ service: 'gateway', destination: { write: () => undefined } }),
  });
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop()]);
});

beforeEach(() => {
  profile.handlers.clear();
  profile.calls.length = 0;
  profile.handlers.set('getCatalogue', () => ({ prompts: [], interests: [] }));
});

describe('photos (M1.6, ADR-0024)', () => {
  it('shows the member all their own photos on Me, pending ones included', async () => {
    const id = member();
    profile.handlers.set('getOwnProfile', () => own(id));
    profile.handlers.set('listOwnPhotos', () => ({
      photos: [
        wirePhoto(PHOTO_ID, 0, PhotoModeration.PHOTO_MODERATION_APPROVED),
        wirePhoto('dddddddd-dddd-4ddd-8ddd-000000000002', 1),
      ],
    }));
    const result = await gql(
      gateway.url,
      `{ me { photos { ${PHOTO_FIELDS} } } }`,
      await session(id),
    );
    expect(result.body.errors).toBeUndefined();
    const photos = (result.body.data as { me: { photos: Record<string, unknown>[] } }).me.photos;
    expect(photos.map((p) => [p['position'], p['status']])).toEqual([
      [0, 'APPROVED'],
      [1, 'PENDING'],
    ]);
    expect(photos[0]).toMatchObject({
      id: PHOTO_ID,
      url: `https://media.test/photos/${PHOTO_ID}/640.webp?sig=x`,
      width: 1600,
      height: 1200,
    });
    expect(profile.calls.find((c) => c.method === 'listOwnPhotos')?.request).toEqual({
      accountId: id,
    });
  });

  it('starts an upload for the signed-in member only', async () => {
    const id = member();
    profile.handlers.set('createPhotoUpload', () => ({
      uploadId: UPLOAD_ID,
      uploadUrl: 'https://storage.test/uploads/x?X-Amz-Signature=abc',
      expiresAt: new Date(1_795_000_000_000),
    }));
    const result = await gql(
      gateway.url,
      `mutation { createPhotoUpload(contentType: "image/jpeg", byteLength: 2048) { uploadId uploadUrl expiresAt } }`,
      await session(id),
    );
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data).toEqual({
      createPhotoUpload: {
        uploadId: UPLOAD_ID,
        uploadUrl: 'https://storage.test/uploads/x?X-Amz-Signature=abc',
        expiresAt: new Date(1_795_000_000_000).toISOString(),
      },
    });
    expect(profile.calls.at(-1)?.request).toEqual({
      accountId: id,
      contentType: 'image/jpeg',
      byteLength: 2048,
    });
  });

  it('completes, reorders and deletes', async () => {
    const id = member();
    const second = 'dddddddd-dddd-4ddd-8ddd-000000000002';
    profile.handlers.set('completePhotoUpload', () => ({ photo: wirePhoto() }));
    profile.handlers.set('reorderPhotos', () => ({
      photos: [wirePhoto(second, 0), wirePhoto(PHOTO_ID, 1)],
    }));
    profile.handlers.set('deletePhoto', () => ({ photos: [wirePhoto(second, 0)] }));
    const auth = await session(id);

    const done = await gql(
      gateway.url,
      `mutation { completePhotoUpload(uploadId: "${UPLOAD_ID}") { ${PHOTO_FIELDS} } }`,
      auth,
    );
    expect(done.body.data).toMatchObject({
      completePhotoUpload: { id: PHOTO_ID, status: 'PENDING' },
    });

    const order = await gql(
      gateway.url,
      `mutation { reorderPhotos(photoIds: ["${second}", "${PHOTO_ID}"]) { id position } }`,
      auth,
    );
    expect(order.body.data).toEqual({
      reorderPhotos: [
        { id: second, position: 0 },
        { id: PHOTO_ID, position: 1 },
      ],
    });
    const left = await gql(
      gateway.url,
      `mutation { deletePhoto(photoId: "${PHOTO_ID}") { id } }`,
      auth,
    );
    expect(left.body.data).toEqual({ deletePhoto: [{ id: second }] });
    expect(profile.calls.map((c) => [c.method, c.request['accountId']])).toEqual([
      ['completePhotoUpload', id],
      ['reorderPhotos', id],
      ['deletePhoto', id],
    ]);
  });

  it('refuses bad input at the edge without calling the service', async () => {
    const auth = await session(member());
    for (const query of [
      'mutation { completePhotoUpload(uploadId: "not-a-uuid") { id } }',
      'mutation { deletePhoto(photoId: "../../etc") { id } }',
      `mutation { reorderPhotos(photoIds: [${Array.from({ length: 7 }, () => `"${PHOTO_ID}"`).join(',')}]) { id } }`,
      'mutation { createPhotoUpload(contentType: "image/jpeg", byteLength: -1) { uploadId } }',
    ]) {
      expect(codes(await gql(gateway.url, query, auth))).toEqual(['BAD_USER_INPUT']);
    }
    expect(profile.calls).toEqual([]);
  });

  it('needs a session', async () => {
    const result = await gql(
      gateway.url,
      'mutation { createPhotoUpload(contentType: "image/jpeg", byteLength: 10) { uploadId } }',
    );
    expect(codes(result)).toEqual(['UNAUTHENTICATED']);
  });

  it("passes on the service's fixed messages and tells a missing profile from a missing photo", async () => {
    const auth = await session(member());
    profile.handlers.set('createPhotoUpload', () => {
      throw new GrpcFailure(status.NOT_FOUND, 'Create your profile first.');
    });
    profile.handlers.set('deletePhoto', () => {
      throw new GrpcFailure(status.NOT_FOUND, 'That photo was not found.');
    });
    profile.handlers.set('completePhotoUpload', () => {
      throw new GrpcFailure(
        status.FAILED_PRECONDITION,
        'You can have up to 6 photos. Delete one to add another.',
      );
    });
    expect(
      codes(
        await gql(
          gateway.url,
          'mutation { createPhotoUpload(contentType: "image/jpeg", byteLength: 10) { uploadId } }',
          auth,
        ),
      ),
    ).toEqual(['PROFILE_REQUIRED']);
    expect(
      codes(
        await gql(gateway.url, `mutation { deletePhoto(photoId: "${PHOTO_ID}") { id } }`, auth),
      ),
    ).toEqual(['NOT_FOUND']);
    const full = await gql(
      gateway.url,
      `mutation { completePhotoUpload(uploadId: "${UPLOAD_ID}") { id } }`,
      auth,
    );
    expect(full.body.errors?.[0]?.message).toBe(
      'You can have up to 6 photos. Delete one to add another.',
    );
  });

  it('allows 20 photo uploads per member per hour, then refuses before signing a link', async () => {
    const id = member();
    const auth = await session(id);
    profile.handlers.set('createPhotoUpload', () => ({
      uploadId: UPLOAD_ID,
      uploadUrl: 'https://storage.test/u',
      expiresAt: new Date(),
    }));
    const start =
      'mutation { createPhotoUpload(contentType: "image/jpeg", byteLength: 10) { uploadId } }';
    // Refused input is not counted.
    await gql(gateway.url, start.replace('10', '-1'), auth);
    for (let i = 0; i < 20; i += 1) {
      expect(codes(await gql(gateway.url, start, auth))).toEqual([]);
    }
    const refused = await gql(gateway.url, start, auth);
    expect(codes(refused)).toEqual(['RATE_LIMITED']);
    expect(refused.body.errors?.[0]?.extensions?.['retryAfterSeconds']).toBeGreaterThan(3500);
    expect(profile.calls.filter((c) => c.method === 'createPhotoUpload')).toHaveLength(20);
    // Another member is unaffected.
    expect(codes(await gql(gateway.url, start, await session(member())))).toEqual([]);
  });
});
