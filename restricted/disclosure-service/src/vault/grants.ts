import { disclosureGrants } from '@chronos/vault-db';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Scope } from '../access/decide.js';

/** Live disclosure grants (`vault.disclosure_grants`). Creating and revoking them is M2.4. */
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
      .where(
        and(
          eq(disclosureGrants.vaultId, vaultId),
          eq(disclosureGrants.viewerAccountId, viewerAccountId),
          isNull(disclosureGrants.revokedAt),
        ),
      );
    return row?.scope;
  }
}
