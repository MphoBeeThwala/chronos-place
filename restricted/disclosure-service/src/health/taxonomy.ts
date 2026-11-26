import { conditionTaxonomy } from '@chronos/vault-db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { OTHER_CODE } from './health-profile.js';

export interface TaxonomyEntry {
  code: string;
  labelEn: string;
  active: boolean;
}

/**
 * The condition list (reference data, no member data). Entries are retired (active = false), never
 * deleted: members who have a retired condition keep it, nobody can newly add it (M2.2 decision).
 */
export class ConditionTaxonomy {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  /** Entries in label order, with "other" last; retired ones only when asked. */
  async list({ includeRetired = false } = {}): Promise<TaxonomyEntry[]> {
    const columns = {
      code: conditionTaxonomy.code,
      labelEn: conditionTaxonomy.labelEn,
      active: conditionTaxonomy.active,
    };
    const rows = includeRetired
      ? await this.#db.select(columns).from(conditionTaxonomy)
      : await this.#db
          .select(columns)
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

  /** Every known code, mapped to whether it is active. */
  async codes(): Promise<Map<string, boolean>> {
    return new Map((await this.list({ includeRetired: true })).map((e) => [e.code, e.active]));
  }
}
