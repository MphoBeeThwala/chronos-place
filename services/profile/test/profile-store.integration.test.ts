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
      'privateMode',
      'prompts',
      'pronouns',
    ]);
    expect((await store.get(viewer))?.profile.hasLocation).toBe(true);
  });

  it('leaves out the viewer and paused profiles, flags private ones, and has no distance without both points', async () => {
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
    expect(views.map((v) => [v.accountId, v.privateMode]).sort()).toEqual(
      [
        [plain, false],
        [hidden, true],
      ].sort(),
    );
    expect(views.find((v) => v.accountId === plain)?.distanceMeters).toBeNull();

    await store.setLocation(plain, null, new Date());
    expect((await store.get(plain))?.profile.hasLocation).toBe(false);
  });
});

describe('discovery candidates (M3.2, ADR-0026)', () => {
  // Johannesburg, Pretoria (about 54 km) and Cape Town (about 1260 km).
  const JHB = { latitude: -26.2, longitude: 28.05 };
  const NEAR = { latitude: -26.21, longitude: 28.06 };
  const PTA = { latitude: -25.75, longitude: 28.19 };
  const CPT = { latitude: -33.92, longitude: 18.42 };

  async function member(
    store: DrizzleProfileStore,
    point: typeof JHB | null,
    options: {
      gender?: string;
      intent?: 'dating' | 'friendship';
      prefs?: Partial<typeof DEFAULT_PREFERENCES>;
      visible?: boolean;
      privateMode?: boolean;
    } = {},
  ): Promise<string> {
    const id = account();
    await store.create(
      id,
      { ...fields, intent: options.intent ?? 'dating', gender: options.gender ?? null },
      { prompts: [], interests: [] },
      { ...DEFAULT_PREFERENCES, ...options.prefs },
    );
    if (point) await store.setLocation(id, point, new Date());
    if (options.visible === false || options.privateMode === true) {
      await store.update(
        id,
        {
          fields: {
            ...(options.visible === false ? { visible: false } : {}),
            ...(options.privateMode === true ? { privateMode: true } : {}),
          },
        },
        new Date(),
      );
    }
    return id;
  }

  it("finds visible members in range, nearest first, fitting both members' preferences", async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    const viewer = await member(store, JHB, {
      gender: 'woman',
      prefs: { maxDistanceKm: 60, genders: ['man'], intents: ['dating'] },
    });
    const near = await member(store, NEAR, { gender: 'man' });
    const pta = await member(store, PTA, { gender: 'man', privateMode: true });
    const far = await member(store, CPT, { gender: 'man' });
    const wrongGender = await member(store, NEAR, { gender: 'woman' });
    const noGender = await member(store, NEAR);
    const wantsMen = await member(store, NEAR, { gender: 'man', prefs: { genders: ['man'] } });
    const tooOldForThem = await member(store, NEAR, {
      gender: 'man',
      prefs: { ageMin: 40, ageMax: 50 },
    });
    const friendsOnly = await member(store, NEAR, { gender: 'man', intent: 'friendship' });
    const paused = await member(store, NEAR, { gender: 'man', visible: false });
    const noLocation = await member(store, null, { gender: 'man' });

    const rows = await store.candidates(viewer, 30, 100);
    const ids = rows.map((r) => r.accountId);
    expect(ids).toEqual([near, pta]);
    expect(rows.map((r) => r.privateMode)).toEqual([false, true]);
    for (const left of [
      far,
      wrongGender,
      noGender,
      wantsMen,
      tooOldForThem,
      friendsOnly,
      paused,
      noLocation,
      viewer,
    ]) {
      expect(ids).not.toContain(left);
    }
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'accountId',
      'distanceMeters',
      'privateMode',
      'signals',
    ]);
  });

  it('pages by distance and id without repeating or skipping anyone', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    // Far from the other tests' members, so nobody else is in range.
    const spot = { latitude: -29.0, longitude: 24.0 };
    const viewer = await member(store, spot, { prefs: { maxDistanceKm: 5 } });
    const same = [];
    // Everyone in one grid cell is the same distance away: the id breaks the tie.
    for (let i = 0; i < 5; i += 1) same.push(await member(store, spot));
    const first = await store.candidates(viewer, 30, 2);
    const second = await store.candidates(viewer, 30, 2, first.at(-1));
    const third = await store.candidates(viewer, 30, 2, second.at(-1));
    const all = [...first, ...second, ...third].map((r) => r.accountId);
    expect(all).toEqual([...same].sort());
    expect(await store.candidateViewer(viewer)).toEqual({
      hasLocation: true,
      ageMin: 18,
      ageMax: 99,
    });
  });
});

describe('ranking signals in the database (M3.3, ADR-0027)', () => {
  it('works them out for the page, with one approved photo counting fully and pending ones not', async () => {
    const store = new DrizzleProfileStore(drizzle(db.pool));
    // Somewhere none of the other tests put anyone.
    const spot = { latitude: -31.0, longitude: 26.0 };
    const viewer = account();
    await store.create(
      viewer,
      fields,
      { prompts: [], interests: [] },
      { ...DEFAULT_PREFERENCES, maxDistanceKm: 10 },
    );
    await store.setLocation(viewer, spot, new Date());
    const [withPhoto, pendingPhoto] = [account(), account()];
    for (const id of [withPhoto, pendingPhoto]) {
      await store.create(
        id,
        { ...fields, bio: 'Synthetic bio' },
        {
          prompts: [{ promptId: 'laugh', answer: 'A' }],
          interests: ['hiking', 'cooking', 'baking'],
        },
        { ...DEFAULT_PREFERENCES, intents: ['friendship'] },
      );
      await store.setLocation(id, spot, new Date());
    }
    const photo = (accountId: string, position: number, moderation: string) =>
      db.pool.query(
        `insert into profile.profile_photos (id, account_id, position, width, height, moderation)
         values (gen_random_uuid(), $1, $2, 640, 640, $3)`,
        [accountId, position, moderation],
      );
    await photo(withPhoto, 0, 'approved');
    await photo(withPhoto, 1, 'approved');
    await photo(pendingPhoto, 0, 'pending');

    const now = new Date(Date.now() + 7 * 86_400_000);
    const rows = await store.candidates(viewer, 30, 10, undefined, now);
    const by = new Map(rows.map((r) => [r.accountId, r.signals]));
    // Same cell: closest possible. Their intents leave out the viewer's (dating): half the fit.
    // Bio 20 + one prompt of three 8 + interests 10, + 20 for the approved photos (counted once).
    expect(by.get(withPhoto)).toEqual({
      closeness: 100,
      mutualFit: 50,
      completenessWithoutBadge: 58,
      newness: 50,
    });
    expect(by.get(pendingPhoto)?.completenessWithoutBadge).toBe(38);
  });
});
