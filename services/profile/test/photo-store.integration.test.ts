import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzlePhotoStore, MAX_PHOTOS } from '../src/photos/photo-store.js';
import { DrizzleProfileStore } from '../src/profiles/profile-store.js';
import { DEFAULT_PREFERENCES } from '../src/profiles/text.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;
let photos: DrizzlePhotoStore;
let profiles: DrizzleProfileStore;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  photos = new DrizzlePhotoStore(drizzle(db.pool));
  profiles = new DrizzleProfileStore(drizzle(db.pool));
});

afterAll(async () => {
  await db.stop();
});

const member = async () => {
  const id = randomUUID();
  await profiles.create(
    id,
    {
      displayName: 'Lerato',
      bio: null,
      intent: 'dating',
      gender: null,
      pronouns: null,
      areaLabel: null,
      privateMode: false,
      visible: true,
    },
    { prompts: [], interests: [] },
    DEFAULT_PREFERENCES,
  );
  return id;
};
const photo = (accountId: string) => ({
  id: randomUUID(),
  accountId,
  width: 800,
  height: 600,
  moderation: 'pending' as const,
});

describe('photos on PostgreSQL', () => {
  it('adds in order and stops at 6, even when completions race', async () => {
    const id = await member();
    const results = await Promise.all(
      Array.from({ length: MAX_PHOTOS + 3 }, () => photos.add(photo(id))),
    );
    expect(results.filter((r) => 'added' in r)).toHaveLength(MAX_PHOTOS);
    expect(results.filter((r) => 'full' in r)).toHaveLength(3);
    expect((await photos.list(id)).map((p) => p.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('refuses a photo without a profile', async () => {
    expect(await photos.add(photo(randomUUID()))).toEqual({ noProfile: true });
    expect(await photos.hasProfile(randomUUID())).toBe(false);
  });

  it('reorders only to exactly the member’s photos, and closes gaps on delete', async () => {
    const id = await member();
    const other = await member();
    const [a, b, c] = [photo(id), photo(id), photo(id)];
    for (const p of [a, b, c]) await photos.add(p);
    const theirs = photo(other);
    await photos.add(theirs);

    expect(await photos.reorder(id, [c.id, a.id, b.id])).toBe(true);
    expect((await photos.list(id)).map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(await photos.reorder(id, [c.id, a.id])).toBe(false);
    expect(await photos.reorder(id, [a.id, b.id, theirs.id])).toBe(false);

    expect(await photos.remove(other, c.id)).toBe(false);
    expect(await photos.remove(id, c.id)).toBe(true);
    expect((await photos.list(id)).map((p) => [p.id, p.position])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);
  });

  it('lists approved photos of several members in order', async () => {
    const one = await member();
    const two = await member();
    const shown = photo(one);
    const hidden = photo(one);
    const theirs = photo(two);
    for (const p of [hidden, shown, theirs]) await photos.add(p);
    await photos.setModeration(shown.id, 'approved');
    await photos.setModeration(theirs.id, 'approved');
    await photos.setModeration(hidden.id, 'rejected');
    // Grouped by member (ordered by account id, which is random here), each member's in order.
    const listed = await photos.approved([one, two]);
    expect(listed.map((p) => p.id).sort()).toEqual([shown.id, theirs.id].sort());
    expect(listed.filter((p) => p.accountId === one).map((p) => p.id)).toEqual([shown.id]);
  });

  it('tracks uploads: own only, open until expiry, then swept oldest first', async () => {
    const id = await member();
    const now = new Date('2026-11-25T10:00:00Z');
    const early = { id: randomUUID(), accountId: id, contentType: 'image/jpeg', byteLength: 10 };
    const late = { ...early, id: randomUUID() };
    await photos.insertUpload({ ...early, expiresAt: new Date(now.getTime() - 60_000) });
    await photos.insertUpload({ ...late, expiresAt: new Date(now.getTime() + 60_000) });
    expect(await photos.openUploads(id, now)).toBe(1);
    expect(await photos.findUpload(randomUUID(), early.id)).toBeUndefined();
    expect((await photos.findUpload(id, early.id))?.byteLength).toBe(10);
    expect((await photos.expiredUploads(now, 10)).map((u) => u.id)).toEqual([early.id]);
    await photos.deleteUpload(early.id);
    expect(await photos.expiredUploads(now, 10)).toEqual([]);
  });

  it('removes photos and uploads with the profile (account erasure)', async () => {
    const id = await member();
    await photos.add(photo(id));
    await photos.insertUpload({
      id: randomUUID(),
      accountId: id,
      contentType: 'image/png',
      byteLength: 5,
      expiresAt: new Date(),
    });
    await db.pool.query('delete from profile.profiles where account_id = $1', [id]);
    expect(await photos.list(id)).toEqual([]);
    const left = await db.pool.query(
      'select count(*)::int as n from profile.photo_uploads where account_id = $1',
      [id],
    );
    expect(left.rows[0]).toEqual({ n: 0 });
  });
});
