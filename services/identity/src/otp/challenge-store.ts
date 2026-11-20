import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { otpChallenges } from '../db/schema.js';

export interface NewChallenge {
  id: string;
  phoneLookup: Buffer;
  prospectiveAccountId: string;
  phoneCiphertext: Buffer;
  phoneNonce: Buffer;
  codeHash: Buffer;
  expiresAt: Date;
}

export interface StoredChallenge extends NewChallenge {
  attempts: number;
}

export interface ChallengeStore {
  insert(challenge: NewChallenge): Promise<void>;
  /** A challenge that is unexpired and unused, or undefined. */
  findOpen(id: string, now: Date): Promise<StoredChallenge | undefined>;
  /**
   * Counts one try, atomically, before the code is compared. Returns the challenge with the new
   * count, or undefined when it is expired, used or out of tries. Concurrent guesses cannot
   * exceed the limit.
   */
  recordAttempt(id: string, maxAttempts: number, now: Date): Promise<StoredChallenge | undefined>;
  /** Marks the challenge used. Returns false if another request used it first. */
  consume(id: string, now: Date): Promise<boolean>;
}

export class DrizzleChallengeStore implements ChallengeStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async insert(challenge: NewChallenge): Promise<void> {
    await this.#db.insert(otpChallenges).values(challenge);
  }

  async findOpen(id: string, now: Date): Promise<StoredChallenge | undefined> {
    const [row] = await this.#db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.id, id),
          isNull(otpChallenges.consumedAt),
          gt(otpChallenges.expiresAt, now),
        ),
      );
    return row && toStored(row);
  }

  async recordAttempt(
    id: string,
    maxAttempts: number,
    now: Date,
  ): Promise<StoredChallenge | undefined> {
    const [row] = await this.#db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(
        and(
          eq(otpChallenges.id, id),
          isNull(otpChallenges.consumedAt),
          gt(otpChallenges.expiresAt, now),
          lt(otpChallenges.attempts, maxAttempts),
        ),
      )
      .returning();
    return row && toStored(row);
  }

  async consume(id: string, now: Date): Promise<boolean> {
    const rows = await this.#db
      .update(otpChallenges)
      .set({ consumedAt: now })
      .where(and(eq(otpChallenges.id, id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id });
    return rows.length === 1;
  }
}

function toStored(row: typeof otpChallenges.$inferSelect): StoredChallenge {
  return {
    id: row.id,
    phoneLookup: row.phoneLookup,
    prospectiveAccountId: row.prospectiveAccountId,
    phoneCiphertext: row.phoneCiphertext,
    phoneNonce: row.phoneNonce,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
  };
}
