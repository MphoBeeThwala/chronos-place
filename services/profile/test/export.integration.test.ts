import { randomUUID } from 'node:crypto';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { ProfileExporter } from '../src/export/profile-export.js';
import { S3PhotoStorage } from '../src/photos/photo-storage.js';
import { DrizzlePhotoStore } from '../src/photos/photo-store.js';
import { EXPORT_TTL_SECONDS, PhotoService } from '../src/photos/photo.service.js';
import { DrizzleProfileStore } from '../src/profiles/profile-store.js';
import { ProfileService } from '../src/profiles/profile.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { FixedModerator } from './support/photo-fakes.js';
import { FakeBlocks, FakeMemberFacts } from './support/profile-fakes.js';
import { startTestS3, type TestS3 } from './support/s3.js';

/** "Download my data", profile's part (ADR-0025 c, i), against PostgreSQL and SeaweedFS. */
let db: TestDatabase;
let s3: TestS3;
let profiles: ProfileService;
let exporter: ProfileExporter;
const logLines: string[] = [];

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  s3 = await startTestS3();
  const orm = drizzle(db.pool);
  const logger = createLogger({
    service: 'profile-test',
    destination: { write: (l: string) => logLines.push(l) },
  });
  profiles = new ProfileService({
    profiles: new DrizzleProfileStore(orm),
    facts: new FakeMemberFacts(),
    visibility: new FakeBlocks(),
    logger,
  });
  const photos = new PhotoService({
    photos: new DrizzlePhotoStore(orm),
    storage: new S3PhotoStorage({
      client: s3.client,
      uploadBucket: s3.uploadBucket,
      mediaBucket: s3.mediaBucket,
    }),
    moderator: new FixedModerator(),
    logger,
  });
  exporter = new ProfileExporter({ db: orm, profiles, photos, logger });
}, 120_000);

afterAll(async () => {
  await s3.stop();
  await db.stop();
});

describe('profile export', () => {
  it('returns the profile, preferences, stored location and every photo with day-long links', async () => {
    const id = randomUUID();
    await profiles.update(id, { displayName: 'Ayanda', intent: 'friendship', bio: 'Synthetic' });
    // Snapped to the 0.01-degree grid before it is stored (ADR-0023).
    await profiles.setLocation(id, { latitude: -26.20412, longitude: 28.04732 });
    const photos = new DrizzlePhotoStore(drizzle(db.pool));
    for (const moderation of ['approved', 'pending', 'rejected'] as const) {
      await photos.add({ id: randomUUID(), accountId: id, width: 640, height: 480, moderation });
    }

    const data = await exporter.export(id);
    expect(data.own?.profile).toMatchObject({ displayName: 'Ayanda', intent: 'friendship' });
    expect(data.own?.preferences.ageMin).toBeGreaterThanOrEqual(18);
    // The stored, snapped point: never the precise one the client sent.
    expect(data.location).toMatchObject({ latitude: -26.2, longitude: 28.05 });
    expect(data.location?.updatedAt).toBeInstanceOf(Date);
    expect(data.photos.map((p) => p.moderation)).toEqual(['approved', 'pending', 'rejected']);
    for (const variant of data.photos.flatMap((p) => p.variants)) {
      expect(new URL(variant.url).searchParams.get('X-Amz-Expires')).toBe(
        String(EXPORT_TTL_SECONDS),
      );
    }
    expect(data.createdAt).toBeInstanceOf(Date);
  });

  it('returns nothing for a member who never made a profile', async () => {
    expect(await exporter.export(randomUUID())).toEqual({
      own: undefined,
      location: undefined,
      photos: [],
      createdAt: undefined,
      updatedAt: undefined,
    });
  });

  it('never logs the location or the profile text', async () => {
    const id = randomUUID();
    await profiles.update(id, { displayName: 'Kagiso', intent: 'dating' });
    await profiles.setLocation(id, { latitude: -33.92, longitude: 18.42 });
    logLines.length = 0;
    await exporter.export(id);
    const logs = logLines.join('\n');
    expect(logs).toContain('profile data exported');
    for (const text of ['Kagiso', '-33.92', '18.42']) expect(logs).not.toContain(text);
  });
});
