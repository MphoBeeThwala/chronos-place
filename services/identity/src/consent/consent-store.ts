import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  consentRecords,
  type ConsentType,
  outbox,
  vaultErasureRequests,
} from '../db/schema.js';
import { type OutboxEvent, outboxValues } from '../events/outbox.js';

export interface ConsentEntry {
  type: ConsentType;
  policyVersion: string;
  granted: boolean;
  recordedAt: Date;
}

/** What else must happen in the same transaction as a consent record. */
export interface ConsentEffects {
  /** Queue erasure of the member's health data, with this idempotency key. */
  vaultErasureRequestId?: string;
  /** Mark the account pending erasure and publish these events (account.erasure_requested). */
  startAccountErasure?: { events: readonly OutboxEvent[] };
}

export interface ConsentStore {
  /** Writes the record and its effects atomically. */
  record(
    id: string,
    accountId: string,
    entry: ConsentEntry,
    effects: ConsentEffects,
  ): Promise<void>;
  history(accountId: string): Promise<ConsentEntry[]>;
  /** The latest entry for each type. */
  latest(accountId: string): Promise<Partial<Record<ConsentType, ConsentEntry>>>;
}

export class DrizzleConsentStore implements ConsentStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async record(
    id: string,
    accountId: string,
    entry: ConsentEntry,
    effects: ConsentEffects,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.insert(consentRecords).values({
        id,
        accountId,
        consentType: entry.type,
        policyVersion: entry.policyVersion,
        granted: entry.granted,
        recordedAt: entry.recordedAt,
      });
      if (effects.vaultErasureRequestId !== undefined) {
        await tx
          .insert(vaultErasureRequests)
          .values({ id: effects.vaultErasureRequestId, accountId });
      }
      if (effects.startAccountErasure) {
        await tx
          .update(accounts)
          .set({ status: 'pending_erasure', updatedAt: entry.recordedAt })
          .where(
            and(
              eq(accounts.id, accountId),
              inArray(accounts.status, ['pending_onboarding', 'active']),
            ),
          );
        const { events } = effects.startAccountErasure;
        if (events.length > 0) await tx.insert(outbox).values(events.map(outboxValues));
      }
    });
  }

  async history(accountId: string): Promise<ConsentEntry[]> {
    const rows = await this.#db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.accountId, accountId))
      .orderBy(asc(consentRecords.recordedAt), asc(consentRecords.id));
    return rows.map(toEntry);
  }

  async latest(accountId: string): Promise<Partial<Record<ConsentType, ConsentEntry>>> {
    const rows = await this.#db
      .selectDistinctOn([consentRecords.consentType])
      .from(consentRecords)
      .where(eq(consentRecords.accountId, accountId))
      .orderBy(
        consentRecords.consentType,
        desc(consentRecords.recordedAt),
        desc(consentRecords.id),
      );
    return Object.fromEntries(rows.map((r) => [r.consentType, toEntry(r)]));
  }
}

function toEntry(row: typeof consentRecords.$inferSelect): ConsentEntry {
  return {
    type: row.consentType,
    policyVersion: row.policyVersion,
    granted: row.granted,
    recordedAt: row.recordedAt,
  };
}
