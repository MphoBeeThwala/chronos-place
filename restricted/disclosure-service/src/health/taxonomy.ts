import { conditionTaxonomy } from '@chronos/vault-db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { OTHER_CODE } from './health-profile.js';

export interface TaxonomyEntry {
  code: string;
  labelEn: string;
}

/** The active condition list (reference data, no member data). */
export class ConditionTaxonomy {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  /** Active entries in label order, with "other" last. */
  async listActive(): Promise<TaxonomyEntry[]> {
    const rows = await this.#db
      .select({ code: conditionTaxonomy.code, labelEn: conditionTaxonomy.labelEn })
      .from(conditionTaxonomy)
      .where(eq(conditionTaxonomy.active, true));
    return rows.sort((a, b) =>
      a.code === OTHER_CODE
        ? 1
        : b.code === OTHER_CODE
          ? -1
          : a.labelEn.localeCompare(b.labelEn, 'en'),
    );
  }

  async activeCodes(): Promise<Set<string>> {
    return new Set((await this.listActive()).map((e) => e.code));
  }
}
