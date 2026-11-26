import type { WrappedKeyRecord, WrappedKeyStore } from '@chronos/crypto';
import { subjectKeys } from '@chronos/vault-db';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Wrapped per-member data keys in `vault.subject_keys`, for `SubjectKeyring` (subject id = vault
 * id). Deleting a row is the crypto-shred (TECHNICAL_SPEC 4.4).
 */
export class VaultKeyStore implements WrappedKeyStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async get(vaultId: string): Promise<WrappedKeyRecord | undefined> {
    const [row] = await this.#db
      .select({ wrapped: subjectKeys.wrappedDek, keyId: subjectKeys.kmsKeyArn })
      .from(subjectKeys)
      .where(eq(subjectKeys.vaultId, vaultId));
    return row && { wrapped: new Uint8Array(row.wrapped), keyId: row.keyId };
  }

  async putIfAbsent(vaultId: string, record: WrappedKeyRecord): Promise<boolean> {
    const rows = await this.#db
      .insert(subjectKeys)
      .values({ vaultId, wrappedDek: Buffer.from(record.wrapped), kmsKeyArn: record.keyId })
      .onConflictDoNothing()
      .returning({ vaultId: subjectKeys.vaultId });
    return rows.length === 1;
  }

  async replace(vaultId: string, record: WrappedKeyRecord): Promise<void> {
    await this.#db
      .update(subjectKeys)
      .set({
        wrappedDek: Buffer.from(record.wrapped),
        kmsKeyArn: record.keyId,
        rotatedAt: sql`now()`,
      })
      .where(eq(subjectKeys.vaultId, vaultId));
  }

  async delete(vaultId: string): Promise<void> {
    await this.#db.delete(subjectKeys).where(eq(subjectKeys.vaultId, vaultId));
  }
}
