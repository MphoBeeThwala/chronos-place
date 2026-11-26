import { subjectMap } from '@chronos/vault-db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Maps account ids to pseudonymous vault ids (`vault.subject_map`). The vault id never leaves the
 * restricted zone; callers only ever see account ids.
 */
export class SubjectDirectory {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  /** The member's vault id, or undefined when they have nothing in the vault. */
  async find(accountId: string): Promise<string | undefined> {
    const [row] = await this.#db
      .select({ vaultId: subjectMap.vaultId })
      .from(subjectMap)
      .where(eq(subjectMap.accountId, accountId));
    return row?.vaultId;
  }

  /** The member's vault id, creating a random one on first use. Safe under concurrent calls. */
  async findOrCreate(accountId: string): Promise<string> {
    const [created] = await this.#db
      .insert(subjectMap)
      .values({ accountId })
      .onConflictDoNothing()
      .returning({ vaultId: subjectMap.vaultId });
    if (created) return created.vaultId;
    const existing = await this.find(accountId);
    if (existing === undefined) throw new Error('subject vanished during lookup');
    return existing;
  }
}
