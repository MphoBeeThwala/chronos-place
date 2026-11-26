/**
 * Health Vault tables, in the `vault` Postgres schema of the separate vault database
 * (TECHNICAL_SPEC §3.3, ADR-0002, ADR-0014, ADR-0015). Restricted zone: only the Disclosure
 * Service uses these. Migrations are generated from this file with
 * `pnpm --filter @chronos/vault-db db:generate` and are forward-only; roles, grants and the
 * audit-log trigger are hand-written migrations (see migrations/0001_roles.sql).
 *
 * Health content is stored only as ciphertext sealed with the member's data key (envelope
 * encryption, @chronos/crypto). Members are known here only by a pseudonymous vault id;
 * `subject_map` is the one place that links it to an account.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** `'a','b'` for a check constraint. Values are compile-time constants, never input. */
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(','));

export const vault = pgSchema('vault');

export const VISIBILITIES = ['hidden', 'match_only', 'chat_grant', 'profile'] as const;
export const GRANT_SCOPES = ['full', 'conditions_only'] as const;
/**
 * Who made a read: `account:<uuid>` (a member, including the subject themself),
 * `service:<name>` (a core service or job) or `staff:<uuid>` (a moderator). Enforced by the
 * database, so nothing else can be written there.
 */
export const ACCESSOR_FORMAT =
  '^((account|staff):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|service:[a-z][a-z0-9-]{0,39})$';
export const ACCESS_PURPOSES = [
  'profile_view',
  'chat_card',
  'moderation',
  'export',
  'erasure',
] as const;
export const ACCESS_DECISIONS = ['allow', 'deny'] as const;

/**
 * A short machine code such as `no_grant`. Enforced by the database so free text (which could
 * carry health detail) can never reach the audit log.
 */
export const REASON_CODE = '^[a-z][a-z0-9_]{0,39}$';
export const CONDITION_CODE = '^[a-z][a-z0-9_]{0,39}$';

/** The only link between a core account and its pseudonymous vault id. */
export const subjectMap = vault.table('subject_map', {
  accountId: uuid('account_id').primaryKey(),
  vaultId: uuid('vault_id').notNull().unique('subject_map_vault_id_unique').defaultRandom(),
  createdAt,
});

/**
 * Each member's data key, wrapped by KMS. Backs @chronos/crypto's WrappedKeyStore (subject id =
 * vault id). Deleting the row is the crypto-shred.
 */
export const subjectKeys = vault.table('subject_keys', {
  vaultId: uuid('vault_id')
    .primaryKey()
    .references(() => subjectMap.vaultId, { onDelete: 'cascade' }),
  wrappedDek: bytea('wrapped_dek').notNull(),
  /** KMS key that wrapped the data key (its ARN in AWS). */
  kmsKeyArn: text('kms_key_arn').notNull(),
  createdAt,
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

/** Reference list of conditions members can choose from. No member data. */
export const conditionTaxonomy = vault.table(
  'condition_taxonomy',
  {
    code: text('code').primaryKey(),
    labelEn: text('label_en').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    check('condition_taxonomy_code_check', sql`${t.code} ~ ${sql.raw(`'${CONDITION_CODE}'`)}`),
  ],
);

/**
 * A member's health profile. `payload_ct` seals `{conditions:[{code,status}], freeText?, note?}`.
 * `version` is bumped on every write so concurrent edits cannot overwrite each other silently.
 */
export const healthProfiles = vault.table(
  'health_profiles',
  {
    vaultId: uuid('vault_id')
      .primaryKey()
      .references(() => subjectMap.vaultId, { onDelete: 'cascade' }),
    payloadCt: bytea('payload_ct').notNull(),
    payloadNonce: bytea('payload_nonce').notNull(),
    visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('hidden'),
    filterOptIn: boolean('filter_opt_in').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (t) => [
    check('health_profiles_visibility_check', sql`${t.visibility} in (${sqlList(VISIBILITIES)})`),
    check('health_profiles_version_check', sql`${t.version} >= 1`),
  ],
);

/** Conditions a member wants to filter matches by (ADR-0015), sealed like the profile. */
export const filterPreferences = vault.table(
  'filter_preferences',
  {
    vaultId: uuid('vault_id')
      .primaryKey()
      .references(() => subjectMap.vaultId, { onDelete: 'cascade' }),
    payloadCt: bytea('payload_ct').notNull(),
    payloadNonce: bytea('payload_nonce').notNull(),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (t) => [check('filter_preferences_version_check', sql`${t.version} >= 1`)],
);

/** A member's permission for one viewer to see their health information. */
export const disclosureGrants = vault.table(
  'disclosure_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => subjectMap.vaultId, { onDelete: 'cascade' }),
    viewerAccountId: uuid('viewer_account_id').notNull(),
    scope: text('scope', { enum: GRANT_SCOPES }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    check('disclosure_grants_scope_check', sql`${t.scope} in (${sqlList(GRANT_SCOPES)})`),
    check(
      'disclosure_grants_revoked_after_granted',
      sql`${t.revokedAt} is null or ${t.revokedAt} >= ${t.grantedAt}`,
    ),
    // At most one live grant per member and viewer.
    uniqueIndex('disclosure_grants_active_unique')
      .on(t.vaultId, t.viewerAccountId)
      .where(sql`${t.revokedAt} is null`),
    index('disclosure_grants_viewer_idx').on(t.viewerAccountId),
  ],
);

/**
 * Append-only record of every vault read decision (CLAUDE.md rule 9). Not linked to
 * `subject_map` by a foreign key: rows outlive erasure, holding only the pseudonymous vault id.
 * A trigger refuses UPDATE, DELETE and TRUNCATE for every role (0001_roles.sql).
 */
export const healthAccessLog = vault.table(
  'health_access_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    vaultId: uuid('vault_id').notNull(),
    accessor: text('accessor').notNull(),
    purpose: text('purpose', { enum: ACCESS_PURPOSES }).notNull(),
    decision: text('decision', { enum: ACCESS_DECISIONS }).notNull(),
    reason: text('reason').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'health_access_log_accessor_check',
      sql`${t.accessor} ~ ${sql.raw(`'${ACCESSOR_FORMAT}'`)}`,
    ),
    check('health_access_log_purpose_check', sql`${t.purpose} in (${sqlList(ACCESS_PURPOSES)})`),
    check('health_access_log_decision_check', sql`${t.decision} in (${sqlList(ACCESS_DECISIONS)})`),
    check('health_access_log_reason_check', sql`${t.reason} ~ ${sql.raw(`'${REASON_CODE}'`)}`),
    index('health_access_log_vault_at_idx').on(t.vaultId, t.at),
  ],
);
