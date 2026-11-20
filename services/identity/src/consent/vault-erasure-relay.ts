import type { Logger } from '@chronos/logger';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { vaultErasureRequests } from '../db/schema.js';

/** Calls the Disclosure Service's EraseSubject (spec 4.1). Idempotent on requestId. */
export interface VaultEraser {
  eraseSubject(accountId: string, requestId: string): Promise<void>;
}

const BATCH = 20;
const MAX_BACKOFF_SECONDS = 3600;

/**
 * Delivers queued health-data erasure requests to the vault until each is confirmed (M1.2 AC:
 * health consent withdrawal triggers vault erasure). Rows are claimed with SKIP LOCKED, so several
 * replicas can run it. The Disclosure Service arrives with M2; until then requests wait here.
 */
export class VaultErasureRelay {
  readonly #db: NodePgDatabase;
  readonly #eraser: VaultEraser;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: {
    db: NodePgDatabase;
    eraser: VaultEraser;
    logger: Logger;
    now?: () => Date;
  }) {
    this.#db = options.db;
    this.#eraser = options.eraser;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const now = this.#now();
      const { rows } = await tx.execute<{ id: string; account_id: string; attempts: number }>(sql`
        select id, account_id, attempts from ${vaultErasureRequests}
         where completed_at is null and next_attempt_at <= ${now}
         order by created_at
         limit ${BATCH}
         for update skip locked`);
      let done = 0;
      for (const row of rows) {
        try {
          await this.#eraser.eraseSubject(row.account_id, row.id);
          await tx.execute(
            sql`update ${vaultErasureRequests} set completed_at = ${now} where id = ${row.id}`,
          );
          done += 1;
        } catch (err) {
          const delay = Math.min(2 ** (row.attempts + 1) * 5, MAX_BACKOFF_SECONDS);
          await tx.execute(sql`
            update ${vaultErasureRequests}
               set attempts = attempts + 1,
                   next_attempt_at = ${new Date(now.getTime() + delay * 1000)}
             where id = ${row.id}`);
          this.#logger.warn({ err, requestId: row.id }, 'vault erasure request failed');
        }
      }
      return done;
    });
  }
}
