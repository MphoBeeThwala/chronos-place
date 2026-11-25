import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzleProfileStore } from '../src/profiles/profile-store.js';
import { DEFAULT_PREFERENCES } from '../src/profiles/text.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

const fields = {
  displayName: 'Naledi',
  bio: null,
  intent: 'dating' as const,
  gender: null,
  pronouns: null,
  areaLabel: null,
  privateMode: false,
  visible: true,
};
let n = 0;
const account = () => `66666666-6666-4666-8666-${String((n += 1)).padStart(12, '0')}`;

describe('profile migrations', () => {
  it('create the profile schema with PostGIS and a geography column', async () => {
    const tables = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'profile' order by 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'photo_uploads',
      'preferences',
      'profile_interests',
      'profile_photos',
      'profile_prompts',
      'profiles',
    ]);
    const column = await db.pool.query<{ udt_name: string }>(
      `select udt_name from information_schema.columns
        where table_schema = 'profile' and table_name = 'profiles' and column_name = 'location'`,
    );
    expect(column.rows[0]?.udt_name).toBe('geography');
  });

  it('are re-runnable', async () => {
    await expect(runMigrations(db.url)).resolves.toBeUndefined();
  });
});

describe('profiles on PostgreSQL', () => {
  it('creates a profile with its preferences, prompts and interests, once', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const id = account();
    const extras = {
      prompts: [
        { promptId: 'laugh', answer: 'Bad puns' },
        { promptId: 'comfort-food', answer: 'Pap and stew' },
      ],
      interests: ['hiking', 'jazz'],
    };
    expect(await store.create(id, fields, extras, DEFAULT_PREFERENCES)).toBe(true);
    expect(await store.create(id, fields, extras, DEFAULT_PREFERENCES)).toBe(false);
    expect(await store.get(id)).toEqual({
      profile: { accountId: id, ...fields, ...extras, hasLocation: false },
      preferences: DEFAULT_PREFERENCES,
    });
  });

  it('replaces prompts and interests only when given', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const id = account();
    await store.create(
      id,
      fields,
      { prompts: [{ promptId: 'laugh', answer: 'x' }], interests: ['jazz'] },
      DEFAULT_PREFERENCES,
    );
    await store.update(id, { fields: { bio: 'Hi' } }, new Date());
    expect((await store.get(id))?.profile).toMatchObject({ bio: 'Hi', interests: ['jazz'] });
    await store.update(id, { fields: {}, prompts: [], interests: ['art', 'film'] }, new Date());
    expect((await store.get(id))?.profile).toMatchObject({
      prompts: [],
      interests: ['art', 'film'],
    });
    expect(await store.update(account(), { fields: { bio: 'x' } }, new Date())).toBe(false);
  });

  it('refuses preferences below 18 even if the service were bypassed', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const id = account();
    await store.create(id, fields, { prompts: [], interests: [] }, DEFAULT_PREFERENCES);
    await expect(
      store.setPreferences(id, { ...DEFAULT_PREFERENCES, ageMin: 16 }, new Date()),
    ).rejects.toThrow();
    await expect(
      db.pool.query(`update profile.preferences set max_distance_km = 0 where account_id = $1`, [
        id,
      ]),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        `insert into profile.profile_prompts (account_id, position, prompt_id, answer)
         values ($1, 3, 'laugh', 'x')`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it('removes prompts, interests and preferences with the profile', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const id = account();
    await store.create(
      id,
      fields,
      { prompts: [{ promptId: 'laugh', answer: 'x' }], interests: ['jazz'] },
      DEFAULT_PREFERENCES,
    );
    await db.pool.query('delete from profile.profiles where account_id = $1', [id]);
    const left = await db.pool.query<{ n: string }>(
      `select (select count(*) from profile.profile_prompts where account_id = $1)
            + (select count(*) from profile.profile_interests where account_id = $1)
            + (select count(*) from profile.preferences where account_id = $1) as n`,
      [id],
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
  });
});

describe('location on PostGIS (M1.5 AC)', () => {
  it('stores the snapped point, measures distance in the database and never selects a coordinate', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const viewer = account();
    const other = account();
    for (const id of [viewer, other]) {
      await store.create(id, fields, { prompts: [], interests: [] }, DEFAULT_PREFERENCES);
    }
    await store.setLocation(viewer, { latitude: -26.2, longitude: 28.05 }, new Date());
    await store.setLocation(other, { latitude: -25.75, longitude: 28.23 }, new Date());

    const stored = await db.pool.query<{ lat: number; lng: number }>(
      `select ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
         from profile.profiles where account_id = $1`,
      [viewer],
    );
    expect(stored.rows[0]).toEqual({ lat: -26.2, lng: 28.05 });

    const [view] = await store.publicProfiles(viewer, [other]);
    expect(view?.distanceMeters).toBeGreaterThan(53_000);
    expect(view?.distanceMeters).toBeLessThan(55_000);
    expect(Object.keys(view ?? {}).sort()).toEqual([
      'accountId',
      'areaLabel',
      'bio',
      'displayName',
      'distanceMeters',
      'gender',
      'intent',
      'interests',
      'prompts',
      'pronouns',
    ]);
    expect((await store.get(viewer))?.profile.hasLocation).toBe(true);
  });

  it('leaves out the viewer, paused and private profiles, and has no distance without both points', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const viewer = account();
    const [plain, paused, hidden] = [account(), account(), account()];
    for (const id of [viewer, plain, paused, hidden]) {
      await store.create(id, fields, { prompts: [], interests: [] }, DEFAULT_PREFERENCES);
    }
    await store.update(paused, { fields: { visible: false } }, new Date());
    await store.update(hidden, { fields: { privateMode: true } }, new Date());
    await store.setLocation(plain, { latitude: -26.2, longitude: 28.05 }, new Date());
    const views = await store.publicProfiles(viewer, [viewer, plain, paused, hidden]);
    expect(views.map((v) => v.accountId)).toEqual([plain]);
    expect(views[0]?.distanceMeters).toBeNull();

    await store.setLocation(plain, null, new Date());
    expect((await store.get(plain))?.profile.hasLocation).toBe(false);
  });
});
