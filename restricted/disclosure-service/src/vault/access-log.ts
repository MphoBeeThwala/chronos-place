import { healthAccessLog } from '@chronos/vault-db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface AccessRecord {
  vaultId: string;
  /** `account:<uuid>`, `service:<name>` or `staff:<uuid>`; the database rejects anything else. */
  accessor: string;
  purpose: 'profile_view' | 'chat_card' | 'moderation' | 'export' | 'erasure' | 'filter';
  decision: 'allow' | 'deny';
  /** A short code such as `self` or `no_grant`; never free text. */
  reason: string;
}

/** Appends to `vault.health_access_log` (CLAUDE.md rule 9). The role cannot change or delete rows. */
export class AccessLog {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async record(entry: AccessRecord): Promise<void> {
    await this.#db.insert(healthAccessLog).values(entry);
  }

  /** Appends several decisions in one statement. */
  async recordMany(entries: readonly AccessRecord[]): Promise<void> {
    if (entries.length > 0) await this.#db.insert(healthAccessLog).values([...entries]);
  }
}
