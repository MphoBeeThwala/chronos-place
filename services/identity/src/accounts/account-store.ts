import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accounts, type AccountStatus, outbox } from '../db/schema.js';
import { type OutboxEvent, outboxValues } from '../events/outbox.js';

export interface AccountRecord {
  id: string;
  status: AccountStatus;
  hasDateOfBirth: boolean;
  /** A liveness check has passed (M1.4). */
  verified: boolean;
}

export interface NewAccount {
  id: string;
  phoneLookup: Buffer;
  phoneCiphertext: Buffer;
  phoneNonce: Buffer;
}

export interface AccountStore {
  findByPhoneLookup(lookup: Buffer): Promise<AccountRecord | undefined>;
  get(id: string): Promise<AccountRecord | undefined>;
  /**
   * Creates a pending account and writes its events to the outbox in the same transaction, or
   * returns false (writing nothing) if the number already has an account (a race).
   */
  insertPending(account: NewAccount, events: readonly OutboxEvent[]): Promise<boolean>;
  /** Stores the date and activates. Only from pending with no date yet; false otherwise. */
  activateWithDateOfBirth(id: string, isoDate: string): Promise<boolean>;
  /** Marks a pending account ineligible for good. The date of birth is not stored. */
  markIneligible(id: string): Promise<boolean>;
  /** Date of birth and verified flag of the active accounts among `ids`; others are left out. */
  activeFacts(ids: readonly string[]): Promise<ActiveFacts[]>;
}

export interface ActiveFacts {
  id: string;
  /** YYYY-MM-DD. Used to work out an age, never returned. */
  dateOfBirth: string;
  verified: boolean;
}

const record = (row: {
  id: string;
  status: AccountStatus;
  dateOfBirth: string | null;
  verifiedAt: Date | null;
}): AccountRecord => ({
  id: row.id,
  status: row.status,
  hasDateOfBirth: row.dateOfBirth !== null,
  verified: row.verifiedAt !== null,
});

const columns = {
  id: accounts.id,
  status: accounts.status,
  dateOfBirth: accounts.dateOfBirth,
  verifiedAt: accounts.verifiedAt,
};

export class DrizzleAccountStore implements AccountStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async findByPhoneLookup(lookup: Buffer): Promise<AccountRecord | undefined> {
    const [row] = await this.#db
      .select(columns)
      .from(accounts)
      .where(eq(accounts.phoneLookup, lookup));
    return row && record(row);
  }

  async get(id: string): Promise<AccountRecord | undefined> {
    const [row] = await this.#db.select(columns).from(accounts).where(eq(accounts.id, id));
    return row && record(row);
  }

  async insertPending(account: NewAccount, events: readonly OutboxEvent[]): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .insert(accounts)
        .values({ ...account, status: 'pending_onboarding' })
        .onConflictDoNothing({ target: accounts.phoneLookup })
        .returning({ id: accounts.id });
      if (rows.length !== 1) return false;
      if (events.length > 0) await tx.insert(outbox).values(events.map(outboxValues));
      return true;
    });
  }

  async activateWithDateOfBirth(id: string, isoDate: string): Promise<boolean> {
    const rows = await this.#db
      .update(accounts)
      .set({ dateOfBirth: isoDate, status: 'active', updatedAt: sql`now()` })
      .where(
        and(
          eq(accounts.id, id),
          eq(accounts.status, 'pending_onboarding'),
          isNull(accounts.dateOfBirth),
        ),
      )
      .returning({ id: accounts.id });
    return rows.length === 1;
  }

  async markIneligible(id: string): Promise<boolean> {
    const rows = await this.#db
      .update(accounts)
      .set({ status: 'ineligible', updatedAt: sql`now()` })
      .where(and(eq(accounts.id, id), eq(accounts.status, 'pending_onboarding')))
      .returning({ id: accounts.id });
    return rows.length === 1;
  }

  async activeFacts(ids: readonly string[]): Promise<ActiveFacts[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db
      .select({
        id: accounts.id,
        dateOfBirth: accounts.dateOfBirth,
        verifiedAt: accounts.verifiedAt,
      })
      .from(accounts)
      .where(
        and(
          inArray(accounts.id, [...ids]),
          eq(accounts.status, 'active'),
          isNotNull(accounts.dateOfBirth),
        ),
      );
    return rows.flatMap((r) =>
      r.dateOfBirth === null
        ? []
        : [{ id: r.id, dateOfBirth: r.dateOfBirth, verified: r.verifiedAt !== null }],
    );
  }
}
