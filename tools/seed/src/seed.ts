import type pg from 'pg';
import { generate, SEED_ID_PREFIX, type SeedOptions } from './generate.js';

export { generate, SEED_ID_PREFIX, type SeedMember, type SeedOptions } from './generate.js';

const BATCH = 5_000;
const SEEDED = `${SEED_ID_PREFIX}%`;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

/** How many seeded accounts the database already holds. */
export async function seededCount(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from identity.accounts where id::text like $1`,
    [SEEDED],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Removes every seeded row (ids starting with 5eed), and nothing else. */
export async function resetSeed(pool: pg.Pool): Promise<void> {
  await pool.query(
    `delete from matching.likes where from_id::text like $1 or to_id::text like $1`,
    [SEEDED],
  );
  await pool.query(
    `delete from matching.blocks where blocker_id::text like $1 or blocked_id::text like $1`,
    [SEEDED],
  );
  await pool.query(`delete from matching.matches where a_id::text like $1 or b_id::text like $1`, [
    SEEDED,
  ]);
  // Preferences, prompts and interests cascade with the profile.
  await pool.query(`delete from profile.profiles where account_id::text like $1`, [SEEDED]);
  await pool.query(`delete from identity.accounts where id::text like $1`, [SEEDED]);
}

/**
 * Writes synthetic members into identity, profile and matching (the schemas must be migrated):
 * accounts with a date of birth and no phone, profiles with snapped locations and preferences, and
 * some likes and passes. Health data is never seeded here.
 */
export async function seed(
  pool: pg.Pool,
  options: SeedOptions = {},
): Promise<{ members: number; decisions: number }> {
  const { members, decisions } = generate(options);
  for (const batch of chunks(members)) {
    await pool.query(
      `insert into identity.accounts (id, status, date_of_birth, verified_at)
       select id, status, dob, case when verified then now() end
         from unnest($1::uuid[], $2::text[], $3::date[], $4::boolean[]) as t(id, status, dob, verified)`,
      [
        batch.map((m) => m.id),
        batch.map((m) => (m.active ? 'active' : 'suspended')),
        batch.map((m) => m.dateOfBirth),
        batch.map((m) => m.verified),
      ],
    );
    await pool.query(
      `insert into profile.profiles
         (account_id, display_name, intent, gender, location, location_updated_at, private_mode, visible)
       select id, name, intent, gender,
              case when lat is null then null
                   else ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography end,
              case when lat is null then null else now() end,
              private, visible
         from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[],
                     $7::boolean[], $8::boolean[])
           as t(id, name, intent, gender, lat, lng, private, visible)`,
      [
        batch.map((m) => m.id),
        batch.map((m) => m.displayName),
        batch.map((m) => m.intent),
        batch.map((m) => m.gender),
        batch.map((m) => m.point?.lat ?? null),
        batch.map((m) => m.point?.lng ?? null),
        batch.map((m) => m.privateMode),
        batch.map((m) => m.visible),
      ],
    );
    await pool.query(
      `insert into profile.preferences (account_id, age_min, age_max, max_distance_km, intents, genders)
       select id, age_min, age_max, distance,
              coalesce(string_to_array(nullif(intents, ''), ','), '{}'),
              coalesce(string_to_array(nullif(genders, ''), ','), '{}')
         from unnest($1::uuid[], $2::int[], $3::int[], $4::int[], $5::text[], $6::text[])
           as t(id, age_min, age_max, distance, intents, genders)`,
      [
        batch.map((m) => m.id),
        batch.map((m) => m.prefs.ageMin),
        batch.map((m) => m.prefs.ageMax),
        batch.map((m) => m.prefs.maxDistanceKm),
        batch.map((m) => m.prefs.intents.join(',')),
        batch.map((m) => m.prefs.genders.join(',')),
      ],
    );
  }
  for (const batch of chunks(decisions)) {
    await pool.query(
      `insert into matching.likes (from_id, to_id, kind)
       select * from unnest($1::uuid[], $2::uuid[], $3::text[])
       on conflict do nothing`,
      [batch.map((d) => d.fromId), batch.map((d) => d.toId), batch.map((d) => d.kind)],
    );
  }
  // Fresh statistics, so the planner sees the real table sizes.
  await pool.query(
    'analyze identity.accounts, profile.profiles, profile.preferences, matching.likes',
  );
  return { members: members.length, decisions: decisions.length };
}
