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
      'preferences',
      'profile_interests',
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
