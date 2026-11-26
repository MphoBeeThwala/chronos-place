import { and, count, eq, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  consentRecords,
  deletionChallenges,
  erasureConfirmations,
  outbox,
  sessions,
  verificationAttempts,
} from '../db/schema.js';
import { type OutboxEvent, outboxValues } from '../events/outbox.js';

/** An account whose every expected service has confirmed, and what still blocks finishing it. */
export interface ReadyErasure {
  accountId: string;
  /** Verification captures or vendor copies still to delete; the data key is needed for that. */
  capturesRemain: boolean;
}

export interface ErasureStore {
  /** Records a service's confirmation for an account being erased. False when ignored. */
  confirm(accountId: string, service: string, at: Date): Promise<boolean>;
  /** Accounts being erased that every one of `services` has confirmed. */
  ready(services: readonly string[], limit: number): Promise<ReadyErasure[]>;
  /**
   * Deletes everything identity holds for the account except its bare id, marks it erased and
   * queues `event` (account.erased), in one transaction. The data key must already be shredded.
   */
  finish(accountId: string, now: Date, event: OutboxEvent): Promise<boolean>;
  /** How many accounts have waited for erasure since before `cutoff`. */
  overdue(cutoff: Date): Promise<number>;
}

export class DrizzleErasureStore implements ErasureStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async confirm(accountId: string, service: string, at: Date): Promise<boolean> {
    // Only for an account still being erased: a late or repeated event changes nothing.
    const { rowCount } = await this.#db.execute(sql`
      insert into ${erasureConfirmations} (account_id, service, confirmed_at)
      select ${accountId}::uuid, ${service}, ${at.toISOString()}::timestamptz
        from ${accounts}
       where ${accounts.id} = ${accountId}::uuid and ${accounts.status} = 'pending_erasure'
      on conflict do nothing`);
    return (rowCount ?? 0) > 0;
  }

  async ready(services: readonly string[], limit: number): Promise<ReadyErasure[]> {
    const confirmed = this.#db
      .select({ accountId: erasureConfirmations.accountId })
      .from(erasureConfirmations)
      .where(inArray(erasureConfirmations.service, [...services]))
      .groupBy(erasureConfirmations.accountId)
      .having(eq(count(), services.length));
    const rows = await this.#db
      .select({
        accountId: accounts.id,
        // Qualified by hand: inside a subquery Drizzle would write bare column names, and a bare
        // "id" would mean the attempt's id, not the account's.
        capturesRemain: sql<boolean>`exists (
          select 1 from identity.verification_attempts va
           where va.account_id = identity.accounts.id
             and (va.capture_key is not null or va.job_ciphertext is not null))`,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.status, 'pending_erasure'),
          services.length === 0 ? sql`true` : inArray(accounts.id, confirmed),
        ),
      )
      .orderBy(accounts.erasureRequestedAt)
      .limit(limit);
    return rows;
  }

  finish(accountId: string, now: Date, event: OutboxEvent): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const erased = await tx
        .update(accounts)
        .set({
          status: 'erased',
          erasedAt: now,
          phoneLookup: null,
          phoneCiphertext: null,
          phoneNonce: null,
          dateOfBirth: null,
          verifiedAt: null,
          updatedAt: now,
        })
        .where(and(eq(accounts.id, accountId), eq(accounts.status, 'pending_erasure')))
        .returning({ id: accounts.id });
      if (erased.length === 0) return false;
      // Refresh tokens go with their sessions (cascade).
      await tx.delete(sessions).where(eq(sessions.accountId, accountId));
      await tx.delete(deletionChallenges).where(eq(deletionChallenges.accountId, accountId));
      await tx.delete(consentRecords).where(eq(consentRecords.accountId, accountId));
      await tx.delete(verificationAttempts).where(eq(verificationAttempts.accountId, accountId));
      await tx.delete(erasureConfirmations).where(eq(erasureConfirmations.accountId, accountId));
      await tx.insert(outbox).values(outboxValues(event));
      return true;
    });
  }

  async overdue(cutoff: Date): Promise<number> {
    const [row] = await this.#db
      .select({ n: count() })
      .from(accounts)
      .where(and(eq(accounts.status, 'pending_erasure'), lte(accounts.erasureRequestedAt, cutoff)));
    return row?.n ?? 0;
  }
}
