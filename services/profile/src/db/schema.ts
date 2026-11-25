/**
 * Profile tables in the core database, in the `profile` Postgres schema (ADR-0023). Only the
 * profile service reads or writes them. Migrations are generated from this file with
 * `pnpm --filter @chronos/profile db:generate` and are forward-only.
 *
 * - No health data (CLAUDE.md rule 1). Condition-aware filter settings live in the Health Vault.
 * - No links to other services' tables (decision e): rows are keyed by account id, and account
 *   erasure removes them through the erasure flow (M1.8).
 * - `location` is stored already snapped to a grid of about 1 km and is never returned (rule 8).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** PostGIS geography point (WGS 84). Written and read only through SQL in the location module. */
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType: () => 'geography(point,4326)',
});

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const profile = pgSchema('profile');

export const INTENTS = ['long_term', 'dating', 'friendship', 'open'] as const;
export type Intent = (typeof INTENTS)[number];

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

export const profiles = profile.table(
  'profiles',
  {
    accountId: uuid('account_id').primaryKey(),
    displayName: text('display_name').notNull(),
    bio: text('bio'),
    intent: text('intent', { enum: INTENTS }).notNull(),
    gender: text('gender'),
    pronouns: text('pronouns'),
    areaLabel: text('area_label'),
    /** Snapped to about 1 km before it is written. Never returned, not even to its owner. */
    location: geographyPoint('location'),
    locationUpdatedAt: timestamp('location_updated_at', { withTimezone: true }),
    /** Data flag until discovery enforces it (ADR-0010). Free, never paywalled (ADR-0023). */
    privateMode: boolean('private_mode').notNull().default(false),
    visible: boolean('visible').notNull().default(true),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('profiles_location_gix').using('gist', t.location),
    check('profiles_intent_check', inList(t.intent.name, INTENTS)),
  ],
);

export const profilePrompts = profile.table(
  'profile_prompts',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => profiles.accountId, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    promptId: text('prompt_id').notNull(),
    answer: text('answer').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.position] }),
    unique('profile_prompts_account_prompt_key').on(t.accountId, t.promptId),
    check('profile_prompts_position_check', sql`${t.position} between 0 and 2`),
  ],
);

export const profileInterests = profile.table(
  'profile_interests',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => profiles.accountId, { onDelete: 'cascade' }),
    interestId: text('interest_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.interestId] })],
);

export const preferences = profile.table(
  'preferences',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => profiles.accountId, { onDelete: 'cascade' }),
    ageMin: smallint('age_min').notNull(),
    ageMax: smallint('age_max').notNull(),
    maxDistanceKm: smallint('max_distance_km').notNull(),
    /** Empty means every intent. */
    intents: text('intents').array().notNull(),
    /** Empty means everyone. */
    genders: text('genders').array().notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // 18 is a hard floor (ADR-0018): no setting can ask to see anyone younger.
    check(
      'preferences_age_check',
      sql`${t.ageMin} >= 18 and ${t.ageMax} <= 99 and ${t.ageMin} <= ${t.ageMax}`,
    ),
    check('preferences_distance_check', sql`${t.maxDistanceKm} between 1 and 300`),
  ],
);
