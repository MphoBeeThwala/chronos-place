import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accounts, otpChallenges, outbox, sessions, vaultErasureRequests } from '../db/schema.js';

/** Expired challenges are kept this long, so a sign-in finishing at the expiry edge is never cut off. */
export const CHALLENGE_GRACE_MS = 10 * 60 * 1000;
/** Expired sessions are deleted a day after expiry; revoked ones after 30 days (theft investigation). */
export const EXPIRED_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;
export const REVOKED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Published events are kept a week for replays, then deleted. */
export const PUBLISHED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Confirmed vault erasures are kept 30 days as proof the request was carried out, then deleted. */
export const COMPLETED_ERASURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH = 500;

export interface CleanupResult {
  challenges: number;
  keysShredded: number;
  sessions: number;
  events: number;
}

/**
 * Deletes what identity no longer needs (CLAUDE.md rule 10). Each code request seals the number
 * under a prospective account id; when the challenge ends without creating that account, its key is
 * shredded here, so the sealed copy becomes unrecoverable. Safe to run on several replicas at once.
 */
export class IdentityCleanup {
  readonly #db: NodePgDatabase;
  readonly #keyring: SubjectKeyring;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: {
    db: NodePgDatabase;
    keyring: SubjectKeyring;
    logger: Logger;
    now?: () => Date;
  }) {
    this.#db = options.db;
    this.#keyring = options.keyring;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<CleanupResult> {
    const now = this.#now().getTime();
    const result = {
      ...(await this.#challenges(new Date(now - CHALLENGE_GRACE_MS))),
      sessions: 0,
      events: 0,
    };

    const deletedSessions = await this.#db.execute(sql`
      delete from ${sessions}
       where expires_at < ${new Date(now - EXPIRED_SESSION_GRACE_MS)}
          or revoked_at < ${new Date(now - REVOKED_SESSION_RETENTION_MS)}`);
    result.sessions = deletedSessions.rowCount ?? 0;

    const deletedEvents = await this.#db.execute(sql`
      delete from ${outbox}
       where published_at < ${new Date(now - PUBLISHED_EVENT_RETENTION_MS)}`);
    result.events = deletedEvents.rowCount ?? 0;

    await this.#db.execute(sql`
      delete from ${vaultErasureRequests}
       where completed_at < ${new Date(now - COMPLETED_ERASURE_RETENTION_MS)}`);

    if (Object.values(result).some((n) => n > 0)) this.#logger.info(result, 'identity cleanup');
    return result;
  }

  async #challenges(before: Date): Promise<{ challenges: number; keysShredded: number }> {
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        prospective_account_id: string;
        used: boolean;
      }>(sql`
        select c.id, c.prospective_account_id,
               exists (select 1 from ${accounts} a where a.id = c.prospective_account_id) as used
          from ${otpChallenges} c
         where c.expires_at < ${before}
         limit ${BATCH}
         for update of c skip locked`);
      let keysShredded = 0;
      for (const row of rows) {
        // The prospective id became the account id: that key protects a real account's number.
        if (row.used) continue;
        await this.#keyring.shred(row.prospective_account_id);
        keysShredded += 1;
      }
      if (rows.length > 0) {
        await tx.execute(sql`
          delete from ${otpChallenges}
           where id in (${sql.join(
             rows.map((r) => sql`${r.id}`),
             sql`, `,
           )})`);
      }
      return { challenges: rows.length, keysShredded };
    });
  }
}
