import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type StartErasure, startErasure } from '../accounts/erasure.js';
import { accounts, type AccountStatus, deletionChallenges } from '../db/schema.js';

/** Rolls the transaction back when the account can no longer be deleted. */
class NotDeletable extends Error {}

/** What sending a deletion code needs from the account. */
export interface DeletionContact {
  status: AccountStatus;
  phoneLookup: Buffer | null;
  phoneCiphertext: Buffer | null;
  phoneNonce: Buffer | null;
}

export interface DeletionStore {
  contact(accountId: string): Promise<DeletionContact | undefined>;
  insertChallenge(challenge: {
    id: string;
    accountId: string;
    codeHash: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Counts one try at this account's challenge, before the code is compared. Returns the code
   * hash, or undefined when the challenge is not this account's, expired, used or out of tries.
   */
  recordAttempt(
    id: string,
    accountId: string,
    maxAttempts: number,
    now: Date,
  ): Promise<Buffer | undefined>;
  /**
   * Uses the challenge and starts erasure in one transaction. False when another request used
   * the challenge first or the account can no longer be deleted.
   */
  confirm(id: string, erasure: StartErasure): Promise<boolean>;
}

export class DrizzleDeletionStore implements DeletionStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async contact(accountId: string): Promise<DeletionContact | undefined> {
    const [row] = await this.#db
      .select({
        status: accounts.status,
        phoneLookup: accounts.phoneLookup,
        phoneCiphertext: accounts.phoneCiphertext,
        phoneNonce: accounts.phoneNonce,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return row;
  }

  async insertChallenge(challenge: {
    id: string;
    accountId: string;
    codeHash: Buffer;
    expiresAt: Date;
  }): Promise<void> {
    await this.#db.insert(deletionChallenges).values(challenge);
  }

  async recordAttempt(
    id: string,
    accountId: string,
    maxAttempts: number,
    now: Date,
  ): Promise<Buffer | undefined> {
    const [row] = await this.#db
      .update(deletionChallenges)
      .set({ attempts: sql`${deletionChallenges.attempts} + 1` })
      .where(
        and(
          eq(deletionChallenges.id, id),
          eq(deletionChallenges.accountId, accountId),
          isNull(deletionChallenges.consumedAt),
          gt(deletionChallenges.expiresAt, now),
          lt(deletionChallenges.attempts, maxAttempts),
        ),
      )
      .returning({ codeHash: deletionChallenges.codeHash });
    return row?.codeHash;
  }

  async confirm(id: string, erasure: StartErasure): Promise<boolean> {
    try {
      return await this.#db.transaction(async (tx) => {
        const used = await tx
          .update(deletionChallenges)
          .set({ consumedAt: erasure.now })
          .where(
            and(
              eq(deletionChallenges.id, id),
              eq(deletionChallenges.accountId, erasure.accountId),
              isNull(deletionChallenges.consumedAt),
            ),
          )
          .returning({ id: deletionChallenges.id });
        if (used.length === 0) return false;
        // Undo the use of the code too when the account can no longer be deleted.
        if (!(await startErasure(tx, erasure))) throw new NotDeletable();
        return true;
      });
    } catch (err) {
      if (err instanceof NotDeletable) return false;
      throw err;
    }
  }
}
