/**
 * Identity tables in the core database, in the `identity` Postgres schema (ADR-0018).
 * Only the identity service reads or writes them. Migrations are generated from this file with
 * `pnpm --filter @chronos/identity db:generate` and are forward-only.
 *
 * Phone numbers are stored only sealed (per-account data key) plus a keyed lookup hash.
 * Codes and refresh tokens are stored only as hashes.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  date,
  index,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const identity = pgSchema('identity');

export const ACCOUNT_STATUSES = [
  'pending_onboarding',
  'active',
  'ineligible',
  'suspended',
  'pending_erasure',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const accounts = identity.table(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    /** HMAC-SHA256 of the E.164 number under the lookup key. Finds the account without decrypting. */
    phoneLookup: bytea('phone_lookup').notNull().unique(),
    /** The number sealed under this account's data key (AES-256-GCM, tag appended). */
    phoneCiphertext: bytea('phone_ciphertext').notNull(),
    phoneNonce: bytea('phone_nonce').notNull(),
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull(),
    /** Null until onboarding; the 18+ rule is applied when it is set. */
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    /** Liveness passed (M1.4). */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    locale: text('locale').notNull().default('en-ZA'),
    createdAt,
    updatedAt,
  },
  (t) => [
    check(
      'accounts_status_check',
      sql.raw(`${t.status.name} in (${ACCOUNT_STATUSES.map((s) => `'${s}'`).join(', ')})`),
    ),
  ],
);

/** Wrapped per-account data keys (`WrappedKeyStore` for `SubjectKeyring`). Deleting a row shreds the key. */
export const accountKeys = identity.table('account_keys', {
  subjectId: uuid('subject_id').primaryKey(),
  wrapped: bytea('wrapped').notNull(),
  keyId: text('key_id').notNull(),
  createdAt,
});

export const otpChallenges = identity.table(
  'otp_challenges',
  {
    id: uuid('id').primaryKey(),
    phoneLookup: bytea('phone_lookup').notNull(),
    /**
     * Account id the number was sealed under. Used as the new account's id if this sign-in
     * creates one; otherwise its key is shredded when the challenge expires (ADR-0018).
     */
    prospectiveAccountId: uuid('prospective_account_id').notNull(),
    phoneCiphertext: bytea('phone_ciphertext').notNull(),
    phoneNonce: bytea('phone_nonce').notNull(),
    /** HMAC-SHA256 over challenge id and code under the code key. */
    codeHash: bytea('code_hash').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index('otp_challenges_phone_lookup_idx').on(t.phoneLookup, t.createdAt),
    index('otp_challenges_expires_at_idx').on(t.expiresAt),
  ],
);

/** A session is one sign-in on one device: a family of refresh tokens. */
export const sessions = identity.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** SHA-256 of the client's random device id. */
    deviceHash: bytea('device_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** See RevokeReason in src/sessions/session-store.ts. */
    revokeReason: text('revoke_reason'),
    createdAt,
  },
  (t) => [index('sessions_account_id_idx').on(t.accountId)],
);

export const refreshTokens = identity.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when exchanged. A second exchange is reuse and revokes the session. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [index('refresh_tokens_session_id_idx').on(t.sessionId)],
);
