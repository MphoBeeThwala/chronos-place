import { createEvent, partitionKey, type EventOf, type Topic } from '@chronos/contracts/events';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { blocks, likes, matches, outbox } from '../db/schema.js';

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/** The pair in the order the matches table and the events use (a < b). */
export const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export interface MatchSummary {
  matchId: string;
  otherAccountId: string;
  createdAt: Date;
}

/**
 * Likes, passes, matches and blocks (TASKS M3.1). Every change to a pair runs in one transaction
 * holding an advisory lock on that pair, so two likes at the same moment create one match. Events
 * are written to the outbox in the same transaction.
 */
export class MatchingStore {
  readonly #db: NodePgDatabase;
  readonly #now: () => Date;

  constructor(db: NodePgDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  /** A like; a like back makes a match. Blocked or unmatched pairs: nothing happens. */
  async like(fromId: string, toId: string): Promise<{ matched: boolean; matchId: string }> {
    return this.#pair(fromId, toId, async (tx) => {
      const none = { matched: false, matchId: '' };
      if (await this.#blocked(tx, fromId, toId)) return none;
      const existing = await this.#match(tx, fromId, toId);
      if (existing) {
        return existing.status === 'active' ? { matched: true, matchId: existing.id } : none;
      }
      await this.#decide(tx, fromId, toId, 'like');
      const [back] = await tx
        .select({ kind: likes.kind })
        .from(likes)
        .where(and(eq(likes.fromId, toId), eq(likes.toId, fromId)));
      if (back?.kind !== 'like') return none;

      const [aId, bId] = ordered(fromId, toId);
      const [created] = await tx.insert(matches).values({ aId, bId }).returning({ id: matches.id });
      if (!created) throw new Error('match insert returned nothing');
      await this.#emit(
        tx,
        createEvent(
          'match.created',
          'matching',
          { matchId: created.id, accountIds: [aId, bId] },
          { now: this.#now() },
        ),
      );
      return { matched: true, matchId: created.id };
    });
  }

  /** A pass: the other member is not shown again. */
  async pass(fromId: string, toId: string): Promise<void> {
    await this.#pair(fromId, toId, async (tx) => {
      if (await this.#blocked(tx, fromId, toId)) return;
      await this.#decide(tx, fromId, toId, 'pass');
    });
  }

  /** Ends the member's match for good. False when the match is not theirs. */
  async unmatch(accountId: string, matchId: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ aId: matches.aId, bId: matches.bId })
      .from(matches)
      .where(
        and(eq(matches.id, matchId), or(eq(matches.aId, accountId), eq(matches.bId, accountId))),
      );
    if (!row) return false;
    await this.#pair(row.aId, row.bId, async (tx) => {
      await this.#end(tx, row.aId, row.bId, 'unmatch');
    });
    return true;
  }

  /** Blocks: ends any match and clears likes both ways. Idempotent. */
  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.#pair(blockerId, blockedId, async (tx) => {
      const added = await tx
        .insert(blocks)
        .values({ blockerId, blockedId })
        .onConflictDoNothing()
        .returning({ blockerId: blocks.blockerId });
      if (added.length === 0) return;
      await tx
        .delete(likes)
        .where(
          or(
            and(eq(likes.fromId, blockerId), eq(likes.toId, blockedId)),
            and(eq(likes.fromId, blockedId), eq(likes.toId, blockerId)),
          ),
        );
      await this.#end(tx, blockerId, blockedId, 'block');
      await this.#emit(
        tx,
        createEvent('block.created', 'matching', { blockerId, blockedId }, { now: this.#now() }),
      );
    });
  }

  /** Removes the member's own block. Restores nothing. */
  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.#db
      .delete(blocks)
      .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)));
  }

  /** Active matches, newest first; `before` is the keyset cursor. */
  async listMatches(
    accountId: string,
    limit: number,
    before?: { createdAt: Date; id: string },
  ): Promise<MatchSummary[]> {
    const mine = or(eq(matches.aId, accountId), eq(matches.bId, accountId));
    const rows = await this.#db
      .select({ id: matches.id, aId: matches.aId, bId: matches.bId, createdAt: matches.createdAt })
      .from(matches)
      .where(
        and(
          mine,
          eq(matches.status, 'active'),
          before
            ? or(
                lt(matches.createdAt, before.createdAt),
                and(eq(matches.createdAt, before.createdAt), lt(matches.id, before.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(matches.createdAt), desc(matches.id))
      .limit(limit);
    return rows.map((r) => ({
      matchId: r.id,
      otherAccountId: r.aId === accountId ? r.bId : r.aId,
      createdAt: r.createdAt,
    }));
  }

  /** One of the member's active matches, or undefined if it is ended or not theirs. */
  async activeMatch(accountId: string, matchId: string): Promise<MatchSummary | undefined> {
    const [row] = await this.#db
      .select({ id: matches.id, aId: matches.aId, bId: matches.bId, createdAt: matches.createdAt })
      .from(matches)
      .where(
        and(
          eq(matches.id, matchId),
          eq(matches.status, 'active'),
          or(eq(matches.aId, accountId), eq(matches.bId, accountId)),
        ),
      );
    return row
      ? {
          matchId: row.id,
          otherAccountId: row.aId === accountId ? row.bId : row.aId,
          createdAt: row.createdAt,
        }
      : undefined;
  }

  async listBlocked(blockerId: string): Promise<{ accountId: string; blockedAt: Date }[]> {
    const rows = await this.#db
      .select({ accountId: blocks.blockedId, blockedAt: blocks.createdAt })
      .from(blocks)
      .where(eq(blocks.blockerId, blockerId))
      .orderBy(desc(blocks.createdAt));
    return rows;
  }

  async relationship(a: string, b: string): Promise<{ blocked: boolean; activeMatchId: string }> {
    const blocked = await this.#blocked(this.#db, a, b);
    const match = await this.#match(this.#db, a, b);
    return { blocked, activeMatchId: match?.status === 'active' ? match.id : '' };
  }

  /** The candidates not blocked either way with the viewer, in the order given. */
  async filterVisible(viewerId: string, candidateIds: readonly string[]): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const ids = [...candidateIds];
    const rows = await this.#db
      .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, viewerId), inArray(blocks.blockedId, ids)),
          and(eq(blocks.blockedId, viewerId), inArray(blocks.blockerId, ids)),
        ),
      );
    const hidden = new Set(rows.map((r) => (r.blockerId === viewerId ? r.blockedId : r.blockerId)));
    return candidateIds.filter((id) => id !== viewerId && !hidden.has(id));
  }

  /**
   * Account erasure (ADR-0025 d): ends the member's active matches (match.ended goes out, so chats
   * close), deletes every like, pass, match and block that names them either way, and confirms with
   * account.erasure_confirmed. All in one transaction holding the lock on every pair involved, so
   * the confirmation is only sent if the rows are really gone. Safe to repeat.
   */
  async erase(accountId: string): Promise<{ matches: number; likes: number; blocks: number }> {
    return this.#db.transaction(async (tx) => {
      const others = await this.#counterparts(tx, accountId);
      for (const other of others) {
        const [a, b] = ordered(accountId, other);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${a}:${b}`}, 0))`);
      }
      // Counterparts found after the locks too: a like that landed while we waited is caught.
      for (const other of await this.#counterparts(tx, accountId)) {
        await this.#end(tx, accountId, other, 'erasure');
      }
      const deletedLikes = await tx
        .delete(likes)
        .where(or(eq(likes.fromId, accountId), eq(likes.toId, accountId)))
        .returning({ fromId: likes.fromId });
      const deletedBlocks = await tx
        .delete(blocks)
        .where(or(eq(blocks.blockerId, accountId), eq(blocks.blockedId, accountId)))
        .returning({ blockerId: blocks.blockerId });
      const deletedMatches = await tx
        .delete(matches)
        .where(or(eq(matches.aId, accountId), eq(matches.bId, accountId)))
        .returning({ id: matches.id });
      await this.#emit(
        tx,
        createEvent(
          'account.erasure_confirmed',
          'matching',
          { accountId, service: 'matching' },
          { now: this.#now() },
        ),
      );
      return {
        matches: deletedMatches.length,
        likes: deletedLikes.length,
        blocks: deletedBlocks.length,
      };
    });
  }

  /** Everyone the member has a like, pass, match or block with, either way, sorted (lock order). */
  async #counterparts(tx: Tx, accountId: string): Promise<string[]> {
    const { rows } = await tx.execute<{ other: string }>(sql`
      select to_id as other from matching.likes where from_id = ${accountId}
      union select from_id from matching.likes where to_id = ${accountId}
      union select blocked_id from matching.blocks where blocker_id = ${accountId}
      union select blocker_id from matching.blocks where blocked_id = ${accountId}
      union select b_id from matching.matches where a_id = ${accountId}
      union select a_id from matching.matches where b_id = ${accountId}
      order by 1`);
    return rows.map((r) => r.other);
  }

  async #pair<T>(x: string, y: string, run: (tx: Tx) => Promise<T>): Promise<T> {
    const [a, b] = ordered(x, y);
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${a}:${b}`}, 0))`);
      return run(tx);
    });
  }

  async #blocked(db: Tx | NodePgDatabase, x: string, y: string): Promise<boolean> {
    const rows = await db
      .select({ blockerId: blocks.blockerId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, x), eq(blocks.blockedId, y)),
          and(eq(blocks.blockerId, y), eq(blocks.blockedId, x)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async #match(db: Tx | NodePgDatabase, x: string, y: string) {
    const [aId, bId] = ordered(x, y);
    const [row] = await db
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(and(eq(matches.aId, aId), eq(matches.bId, bId)));
    return row;
  }

  async #decide(tx: Tx, fromId: string, toId: string, kind: 'like' | 'pass'): Promise<void> {
    await tx
      .insert(likes)
      .values({ fromId, toId, kind })
      .onConflictDoUpdate({
        target: [likes.fromId, likes.toId],
        set: { kind, createdAt: sql`now()` },
      });
  }

  async #end(tx: Tx, x: string, y: string, reason: 'unmatch' | 'block' | 'erasure'): Promise<void> {
    const [aId, bId] = ordered(x, y);
    const ended = await tx
      .update(matches)
      .set({ status: 'ended', endedReason: reason, endedAt: sql`now()` })
      .where(and(eq(matches.aId, aId), eq(matches.bId, bId), eq(matches.status, 'active')))
      .returning({ id: matches.id });
    for (const row of ended) {
      await this.#emit(
        tx,
        createEvent(
          'match.ended',
          'matching',
          { matchId: row.id, accountIds: [aId, bId] },
          { now: this.#now() },
        ),
      );
    }
  }

  async #emit(tx: Tx, event: EventOf<Topic>): Promise<void> {
    await tx.insert(outbox).values({
      id: event.eventId,
      topic: event.type,
      partitionKey: partitionKey(event),
      payload: event,
    });
  }
}
