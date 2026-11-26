/**
 * Matching tables in the core database, in the `matching` Postgres schema (TECHNICAL_SPEC 3.2,
 * TASKS M3.1). Only the matching service reads or writes them. Migrations are generated from this
 * file with `pnpm --filter @chronos/matching db:generate` and are forward-only.
 *
 * Ids only: no profile text, no health data. Rows are keyed by account id; account erasure removes
 * them through the erasure flow.
 *
 * Approved rules (M3.1): a block ends any match and clears likes both ways; an unblock restores
 * nothing; an unmatch is final, so an ended match row keeps the pair from ever matching again.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const matching = pgSchema('matching');

export const LIKE_KINDS = ['like', 'pass'] as const;
export const MATCH_STATUSES = ['active', 'ended'] as const;
/** Why a match ended. Never shown to the other member. */
export const END_REASONS = ['unmatch', 'block', 'erasure'] as const;

/** A member's like or pass on another. The latest decision wins. */
export const likes = matching.table(
  'likes',
  {
    fromId: uuid('from_id').notNull(),
    toId: uuid('to_id').notNull(),
    kind: text('kind', { enum: LIKE_KINDS }).notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.fromId, t.toId] }),
    check('likes_kind_check', sql`${t.kind} in ('like', 'pass')`),
    check('likes_not_self', sql`${t.fromId} <> ${t.toId}`),
    index('likes_to_idx').on(t.toId),
  ],
);

/** One row per pair, ever (a_id < b_id). An ended match is kept so the pair never rematches. */
export const matches = matching.table(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aId: uuid('a_id').notNull(),
    bId: uuid('b_id').notNull(),
    status: text('status', { enum: MATCH_STATUSES }).notNull().default('active'),
    endedReason: text('ended_reason', { enum: END_REASONS }),
    createdAt,
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('matches_pair_unique').on(t.aId, t.bId),
    check('matches_ordered_pair', sql`${t.aId} < ${t.bId}`),
    check('matches_status_check', sql`${t.status} in ('active', 'ended')`),
    check(
      'matches_end_check',
      sql`(${t.status} = 'active') = (${t.endedAt} is null and ${t.endedReason} is null)`,
    ),
    index('matches_b_idx').on(t.bId),
  ],
);

export const blocks = matching.table(
  'blocks',
  {
    blockerId: uuid('blocker_id').notNull(),
    blockedId: uuid('blocked_id').notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    check('blocks_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
    index('blocks_blocked_idx').on(t.blockedId),
  ],
);

/** Events waiting for Kafka (ADR-0019), written in the same transaction as the change. */
export const outbox = matching.table(
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
