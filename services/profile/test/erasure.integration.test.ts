import { randomUUID } from 'node:crypto';
import { createEvent } from '@chronos/contracts/events';
import { InMemoryEventBus } from '@chronos/events';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { ProfileEraser } from '../src/erasure/profile-eraser.js';
import {
  type PhotoStorage,
  PhotoStorageError,
  S3PhotoStorage,
} from '../src/photos/photo-storage.js';
import { DrizzlePhotoStore } from '../src/photos/photo-store.js';
import { allSizes, uploadKey } from '../src/photos/photo.service.js';
import { DrizzleProfileStore } from '../src/profiles/profile-store.js';
import { DEFAULT_PREFERENCES } from '../src/profiles/text.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { startTestS3, type TestS3 } from './support/s3.js';

/** Profile's part of account erasure (ADR-0025 d), against PostgreSQL and SeaweedFS. */
let db: TestDatabase;
let s3: TestS3;
let storage: S3PhotoStorage;
let bus: InMemoryEventBus;
const logLines: string[] = [];
const logger = createLogger({
  service: 'profile-test',
  destination: { write: (l: string) => logLines.push(l) },
});

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  s3 = await startTestS3();
  storage = new S3PhotoStorage({
    client: s3.client,
    uploadBucket: s3.uploadBucket,
    mediaBucket: s3.mediaBucket,
  });
}, 120_000);

afterAll(async () => {
  await s3.stop();
  await db.stop();
});

beforeEach(() => {
  bus = new InMemoryEventBus();
  logLines.length = 0;
});

/** The real storage, with any methods a test replaces. */
const eraser = (over: Partial<PhotoStorage> = {}) => {
  const real: PhotoStorage = {
    uploadUrl: (...a) => storage.uploadUrl(...a),
    readUpload: (...a) => storage.readUpload(...a),
    deleteUpload: (...a) => storage.deleteUpload(...a),
    putMedia: (...a) => storage.putMedia(...a),
    deleteMedia: (...a) => storage.deleteMedia(...a),
    viewUrl: (...a) => storage.viewUrl(...a),
  };
  return new ProfileEraser({
    db: drizzle(db.pool),
    storage: { ...real, ...over },
    publisher: bus,
    logger,
  });
};

const requested = (accountId: string) =>
  createEvent('account.erasure_requested', 'identity', {
    accountId,
    requestedAt: new Date().toISOString(),
  });

/** A member with a full profile, two photos with every size stored, and an open upload. */
async function member() {
  const id = randomUUID();
  await new DrizzleProfileStore(drizzle(db.pool)).create(
    id,
    {
      displayName: 'Naledi',
      bio: 'Synthetic bio',
      intent: 'dating',
      gender: null,
      pronouns: null,
      areaLabel: null,
      privateMode: false,
      visible: true,
    },
    { prompts: [{ promptId: 'laugh', answer: 'Synthetic answer' }], interests: ['jazz'] },
    DEFAULT_PREFERENCES,
  );
  const photos = new DrizzlePhotoStore(drizzle(db.pool));
  const photoIds = [randomUUID(), randomUUID()];
  for (const photoId of photoIds) {
    await photos.add({
      id: photoId,
      accountId: id,
      width: 640,
      height: 640,
      moderation: 'approved',
    });
    for (const key of allSizes(photoId)) await storage.putMedia(key, Buffer.from('synthetic'));
  }
  const uploadId = randomUUID();
  await photos.insertUpload({
    id: uploadId,
    accountId: id,
    contentType: 'image/jpeg',
    byteLength: 9,
    expiresAt: new Date(Date.now() + 600_000),
  });
  const url = await storage.uploadUrl(uploadKey(uploadId), 'image/jpeg', 9, 300);
  await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: 'synthetic' });
  return { id, photoIds, uploadId };
}

/** Rows profile still holds for the account, per table. */
async function rows(id: string) {
  const { rows: r } = await db.pool.query<Record<string, number>>(
    `select
       (select count(*) from profile.profiles where account_id = $1)::int as profiles,
       (select count(*) from profile.profile_prompts where account_id = $1)::int as prompts,
       (select count(*) from profile.profile_interests where account_id = $1)::int as interests,
       (select count(*) from profile.preferences where account_id = $1)::int as preferences,
       (select count(*) from profile.profile_photos where account_id = $1)::int as photos,
       (select count(*) from profile.photo_uploads where account_id = $1)::int as uploads`,
    [id],
  );
  return r[0];
}

/** How many of the member's files are still in storage. */
async function files(m: { photoIds: string[]; uploadId: string }) {
  let found = 0;
  for (const key of m.photoIds.flatMap(allSizes)) {
    const res = await fetch(await storage.viewUrl(key, 60));
    if (res.ok) found += 1;
  }
  if (await storage.readUpload(uploadKey(m.uploadId), 100)) found += 1;
  return found;
}

const NONE = { profiles: 0, prompts: 0, interests: 0, preferences: 0, photos: 0, uploads: 0 };

describe('profile erasure (ADR-0025 d)', () => {
  it('deletes every row and file, then confirms', async () => {
    const m = await member();
    expect(await files(m)).toBe(m.photoIds.length * allSizes('x').length + 1);

    await eraser().erase(requested(m.id));

    expect(await rows(m.id)).toEqual(NONE);
    expect(await files(m)).toBe(0);
    expect(bus.published.map((p) => [p.topic, p.key])).toEqual([
      ['account.erasure_confirmed', m.id],
    ]);
    expect(bus.published[0]?.event).toMatchObject({
      producer: 'profile',
      data: { accountId: m.id, service: 'profile' },
    });
  });

  it('confirms again when the request is redelivered, and for a member with no profile', async () => {
    const m = await member();
    await eraser().erase(requested(m.id));
    await eraser().erase(requested(m.id));
    const nobody = randomUUID();
    await eraser().erase(requested(nobody));
    expect(bus.published.map((p) => p.key)).toEqual([m.id, m.id, nobody]);
  });

  it('keeps every row and sends no confirmation when a file cannot be deleted', async () => {
    const m = await member();
    const failing = eraser({
      deleteMedia: () => Promise.reject(new PhotoStorageError('synthetic failure')),
    });
    await expect(failing.erase(requested(m.id))).rejects.toThrow(PhotoStorageError);
    // The rows still name the files, so the retry can delete them.
    expect(await rows(m.id)).toMatchObject({ profiles: 1, photos: 2, uploads: 1 });
    expect(bus.published).toEqual([]);

    await eraser().erase(requested(m.id));
    expect(await rows(m.id)).toEqual(NONE);
    expect(await files(m)).toBe(0);
  });

  it('logs counts, never the profile’s contents', async () => {
    const m = await member();
    await eraser().erase(requested(m.id));
    const logs = logLines.join('\n');
    expect(logs).toContain('profile data erased');
    for (const text of ['Naledi', 'Synthetic bio', 'Synthetic answer', 'jazz']) {
      expect(logs).not.toContain(text);
    }
  });
});
