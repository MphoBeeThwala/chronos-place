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
  boolean,
  integer,
  jsonb,
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

/**
 * Transactional outbox (spec 7). Events are written in the same transaction as the change they
 * describe and published to Kafka afterwards, so an event is never lost or sent for a rolled-back
 * change. Payloads follow @chronos/contracts event schemas: ids and timestamps only.
 */
export const outbox = identity.table(
  'outbox',
  {
    /** The event's eventId, which consumers dedupe on. */
    id: uuid('id').primaryKey(),
    topic: text('topic').notNull(),
    partitionKey: text('partition_key').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [index('outbox_pending_idx').on(t.publishedAt, t.nextAttemptAt)],
);

export const CONSENT_TYPES = [
  'terms',
  'privacy',
  'health_processing',
  'marketing',
  'biometric_verification',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/**
 * Consent history (TASKS M1.2). Append-only: a trigger (migration 0003) refuses updates, so the
 * record of what a member agreed to, and when, cannot be rewritten. Rows go only when the account
 * is erased (cascade). Consent records are Confidential (spec 2).
 */
export const consentRecords = identity.table(
  'consent_records',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    consentType: text('consent_type', { enum: CONSENT_TYPES }).notNull(),
    policyVersion: text('policy_version').notNull(),
    granted: boolean('granted').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('consent_records_account_idx').on(t.accountId, t.recordedAt),
    check(
      'consent_records_type_check',
      sql.raw(`${t.consentType.name} in (${CONSENT_TYPES.map((c) => `'${c}'`).join(', ')})`),
    ),
  ],
);

/**
 * Requests to erase a member's health data, sent to the Disclosure Service's EraseSubject
 * (spec 4.1: identity is an allowed caller). Written in the same transaction as the withdrawal
 * and retried until the vault confirms. The row says only "erase this subject"; the reason is
 * not stored, because even that would imply health data (CLAUDE.md rule 3).
 */
export const vaultErasureRequests = identity.table(
  'vault_erasure_requests',
  {
    /** Idempotency key sent as EraseSubjectRequest.request_id. */
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [index('vault_erasure_pending_idx').on(t.completedAt, t.nextAttemptAt)],
);

export const VERIFICATION_OUTCOMES = ['pending', 'passed', 'failed', 'unavailable'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const VERIFICATION_FAILURES = ['poor_quality', 'not_confirmed'] as const;
export type VerificationFailure = (typeof VERIFICATION_FAILURES)[number];

/**
 * Liveness checks (TASKS M1.4, ADR-0022). One row per capture submitted. Stores the outcome and a
 * coarse reason only: no scores, face templates or vendor responses. The row id is the random
 * reference sent to the vendor, so the vendor never sees the account id. The vendor's job id is
 * sealed under the account key. The capture itself lives in object storage, sealed the same way,
 * and is deleted after 30 days, when the biometric consent is withdrawn, or (by crypto-shred) when
 * the account is erased.
 */
export const verificationAttempts = identity.table(
  'verification_attempts',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    outcome: text('outcome', { enum: VERIFICATION_OUTCOMES }).notNull(),
    failure: text('failure', { enum: VERIFICATION_FAILURES }),
    /** The vendor's job id, sealed under the account key. Null until the vendor accepts the capture. */
    jobCiphertext: bytea('job_ciphertext'),
    jobNonce: bytea('job_nonce'),
    /** Object-storage key of the sealed capture. Null once it has been deleted. */
    captureKey: text('capture_key'),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    checks: integer('checks').notNull().default(0),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** The member asked for a person to review this failed check. */
    reviewRequestedAt: timestamp('review_requested_at', { withTimezone: true }),
    /**
     * Set when the capture and the vendor's copy must be deleted before the 30 days are up
     * (consent withdrawn, or a check that could not be completed).
     */
    purgeRequestedAt: timestamp('purge_requested_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index('verification_attempts_account_idx').on(t.accountId, t.createdAt),
    index('verification_attempts_check_idx').on(t.outcome, t.nextCheckAt),
    index('verification_attempts_capture_idx')
      .on(t.createdAt)
      .where(sql`capture_key is not null`),
    check(
      'verification_attempts_outcome_check',
      sql.raw(`${t.outcome.name} in (${VERIFICATION_OUTCOMES.map((o) => `'${o}'`).join(', ')})`),
    ),
    check(
      'verification_attempts_failure_check',
      sql.raw(
        `${t.failure.name} is null or ${t.failure.name} in (${VERIFICATION_FAILURES.map((f) => `'${f}'`).join(', ')})`,
      ),
    ),
  ],
);
