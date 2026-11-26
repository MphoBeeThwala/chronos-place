import { disclosureGrants } from '@chronos/vault-db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Scope } from '../access/decide.js';

/**
 * One-to-one disclosure grants (`vault.disclosure_grants`). At most one live grant per member and
 * viewer (unique index); ending one sets `revoked_at`, so each consent keeps its own times.
 */
export class Grants {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  /** The scope of the subject's live grant to this viewer, if any. */
  async liveScope(vaultId: string, viewerAccountId: string): Promise<Scope | undefined> {
    const [row] = await this.#db
      .select({ scope: disclosureGrants.scope })
      .from(disclosureGrants)
      .where(this.#live(vaultId, viewerAccountId));
    return row?.scope;
  }

  /**
   * Shares with the viewer, ending any live grant first (a scope change is a new consent).
   * A concurrent grant to the same viewer makes this throw the database's unique-violation error.
   */
  async replace(
    vaultId: string,
    viewerAccountId: string,
    scope: Scope,
  ): Promise<{ id: string; grantedAt: Date }> {
    return this.#db.transaction(async (tx) => {
      await tx
        .update(disclosureGrants)
        .set({ revokedAt: sql`now()` })
        .where(this.#live(vaultId, viewerAccountId));
      const [row] = await tx
        .insert(disclosureGrants)
        .values({ vaultId, viewerAccountId, scope })
        .returning({ id: disclosureGrants.id, grantedAt: disclosureGrants.grantedAt });
      if (row === undefined) throw new Error('grant insert returned nothing');
      return row;
    });
  }

  /** Ends the live grant; false when there was none. */
  async revoke(vaultId: string, viewerAccountId: string): Promise<boolean> {
    const rows = await this.#db
      .update(disclosureGrants)
      .set({ revokedAt: sql`now()` })
      .where(this.#live(vaultId, viewerAccountId))
      .returning({ id: disclosureGrants.id });
    return rows.length > 0;
  }

  #live(vaultId: string, viewerAccountId: string) {
    return and(
      eq(disclosureGrants.vaultId, vaultId),
      eq(disclosureGrants.viewerAccountId, viewerAccountId),
      isNull(disclosureGrants.revokedAt),
    );
  }
}
