import type { WrappedKeyRecord, WrappedKeyStore } from '@chronos/crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accountKeys } from '../db/schema.js';

/**
 * Wrapped per-account data keys for `SubjectKeyring` (purpose "identity"). Deleting a row is the
 * crypto-shred: the phone number sealed under that key can no longer be decrypted (ADR-0018).
 */
export class DrizzleAccountKeyStore implements WrappedKeyStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async get(subjectId: string): Promise<WrappedKeyRecord | undefined> {
    const [row] = await this.#db
      .select({ wrapped: accountKeys.wrapped, keyId: accountKeys.keyId })
      .from(accountKeys)
      .where(eq(accountKeys.subjectId, subjectId));
    return row && { wrapped: new Uint8Array(row.wrapped), keyId: row.keyId };
  }

  async putIfAbsent(subjectId: string, record: WrappedKeyRecord): Promise<boolean> {
    const rows = await this.#db
      .insert(accountKeys)
      .values({ subjectId, wrapped: Buffer.from(record.wrapped), keyId: record.keyId })
      .onConflictDoNothing()
      .returning({ subjectId: accountKeys.subjectId });
    return rows.length === 1;
  }

  async replace(subjectId: string, record: WrappedKeyRecord): Promise<void> {
    await this.#db
      .update(accountKeys)
      .set({ wrapped: Buffer.from(record.wrapped), keyId: record.keyId })
      .where(eq(accountKeys.subjectId, subjectId));
  }

  async delete(subjectId: string): Promise<void> {
    await this.#db.delete(accountKeys).where(eq(accountKeys.subjectId, subjectId));
  }
}
