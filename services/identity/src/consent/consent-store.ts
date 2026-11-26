import { asc, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { consentRecords, type ConsentType, vaultErasureRequests } from '../db/schema.js';
import { startErasure } from '../accounts/erasure.js';
import type { OutboxEvent } from '../events/outbox.js';

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
  /**
   * Start account erasure (ADR-0025): pending_erasure, number freed, health erasure queued under
   * this key, and these events published (account.erasure_requested).
   */
  startAccountErasure?: { vaultRequestId: string; events: OutboxEvent[] };
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
        await startErasure(tx, {
          accountId,
          now: entry.recordedAt,
          ...effects.startAccountErasure,
        });
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
