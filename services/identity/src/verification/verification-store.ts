import { and, desc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  type VerificationFailure,
  type VerificationOutcome,
  verificationAttempts,
} from '../db/schema.js';

export interface AttemptRecord {
  id: string;
  outcome: VerificationOutcome;
  failure: VerificationFailure | null;
  hasCapture: boolean;
  reviewRequested: boolean;
  createdAt: Date;
}

/** The vendor job id, sealed under the account key. */
export interface SealedJob {
  ciphertext: Buffer;
  nonce: Buffer;
}

export interface CheckDue {
  id: string;
  accountId: string;
  job: SealedJob;
  checks: number;
  createdAt: Date;
}

export interface PurgeDue {
  id: string;
  accountId: string;
  captureKey: string | null;
  job: SealedJob | null;
}

/** How many recent attempts are read to work out status, limits and review eligibility. */
export const HISTORY_LIMIT = 50;

export interface VerificationStore {
  /** Newest first, at most HISTORY_LIMIT. */
  recent(accountId: string): Promise<AttemptRecord[]>;
  insertPending(attempt: {
    id: string;
    accountId: string;
    provider: string;
    captureKey: string;
  }): Promise<void>;
  /** The vendor accepted the capture: remember its job and when to ask for the result. */
  accepted(id: string, job: SealedJob, nextCheckAt: Date): Promise<void>;
  /** Pending attempts whose result is due, oldest first. */
  dueChecks(now: Date, limit: number): Promise<CheckDue[]>;
  reschedule(id: string, nextCheckAt: Date): Promise<void>;
  /**
   * Records a final outcome, only while the attempt is still pending (false otherwise). A pass
   * marks the account verified in the same transaction. "unavailable" also asks for the capture
   * to be purged, because there is nothing to appeal.
   */
  decide(
    id: string,
    outcome: Exclude<VerificationOutcome, 'pending'>,
    failure: VerificationFailure | null,
    now: Date,
  ): Promise<boolean>;
  /** Marks the attempt for human review if it is a failed one with its capture still kept. */
  requestReview(id: string, now: Date): Promise<boolean>;
  /**
   * Biometric consent withdrawn: clears the verified mark, ends any running check and asks for
   * every capture and vendor copy of this account to be purged.
   */
  forgetAccount(accountId: string, now: Date): Promise<void>;
  /** Attempts whose capture or vendor copy must go: older than `cutoff`, or purge requested. */
  duePurges(cutoff: Date, now: Date, limit: number): Promise<PurgeDue[]>;
  /** The capture and vendor copy are gone: drop the references. */
  purged(id: string): Promise<void>;
}

const sealedJob = (ciphertext: Buffer | null, nonce: Buffer | null): SealedJob | null =>
  ciphertext && nonce ? { ciphertext, nonce } : null;

export class DrizzleVerificationStore implements VerificationStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async recent(accountId: string): Promise<AttemptRecord[]> {
    const t = verificationAttempts;
    const rows = await this.#db
      .select({
        id: t.id,
        outcome: t.outcome,
        failure: t.failure,
        captureKey: t.captureKey,
        reviewRequestedAt: t.reviewRequestedAt,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(HISTORY_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      outcome: r.outcome,
      failure: r.failure,
      hasCapture: r.captureKey !== null,
      reviewRequested: r.reviewRequestedAt !== null,
      createdAt: r.createdAt,
    }));
  }

  async insertPending(attempt: {
    id: string;
    accountId: string;
    provider: string;
    captureKey: string;
  }): Promise<void> {
    await this.#db.insert(verificationAttempts).values({ ...attempt, outcome: 'pending' });
  }

  async accepted(id: string, job: SealedJob, nextCheckAt: Date): Promise<void> {
    await this.#db
      .update(verificationAttempts)
      .set({ jobCiphertext: job.ciphertext, jobNonce: job.nonce, nextCheckAt })
      .where(and(eq(verificationAttempts.id, id), eq(verificationAttempts.outcome, 'pending')));
  }

  async dueChecks(now: Date, limit: number): Promise<CheckDue[]> {
    const t = verificationAttempts;
    const rows = await this.#db
      .select({
        id: t.id,
        accountId: t.accountId,
        jobCiphertext: t.jobCiphertext,
        jobNonce: t.jobNonce,
        checks: t.checks,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(and(eq(t.outcome, 'pending'), lte(t.nextCheckAt, now), isNotNull(t.jobCiphertext)))
      .orderBy(t.nextCheckAt)
      .limit(limit);
    return rows.flatMap((r) => {
      const job = sealedJob(r.jobCiphertext, r.jobNonce);
      return job
        ? [{ id: r.id, accountId: r.accountId, job, checks: r.checks, createdAt: r.createdAt }]
        : [];
    });
  }

  async reschedule(id: string, nextCheckAt: Date): Promise<void> {
    await this.#db
      .update(verificationAttempts)
      .set({ nextCheckAt, checks: sql`${verificationAttempts.checks} + 1` })
      .where(eq(verificationAttempts.id, id));
  }

  decide(
    id: string,
    outcome: Exclude<VerificationOutcome, 'pending'>,
    failure: VerificationFailure | null,
    now: Date,
  ): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const t = verificationAttempts;
      const [row] = await tx
        .update(t)
        .set({
          outcome,
          failure: outcome === 'failed' ? failure : null,
          decidedAt: now,
          nextCheckAt: null,
          ...(outcome === 'unavailable' ? { purgeRequestedAt: now } : {}),
        })
        .where(and(eq(t.id, id), eq(t.outcome, 'pending')))
        .returning({ accountId: t.accountId });
      if (!row) return false;
      if (outcome === 'passed') {
        await tx
          .update(accounts)
          .set({ verifiedAt: now, updatedAt: now })
          .where(and(eq(accounts.id, row.accountId), isNull(accounts.verifiedAt)));
      }
      return true;
    });
  }

  async requestReview(id: string, now: Date): Promise<boolean> {
    const t = verificationAttempts;
    const rows = await this.#db
      .update(t)
      .set({ reviewRequestedAt: now })
      .where(
        and(
          eq(t.id, id),
          eq(t.outcome, 'failed'),
          isNull(t.reviewRequestedAt),
          isNotNull(t.captureKey),
          isNull(t.purgeRequestedAt),
        ),
      )
      .returning({ id: t.id });
    return rows.length > 0;
  }

  forgetAccount(accountId: string, now: Date): Promise<void> {
    return this.#db.transaction(async (tx) => {
      const t = verificationAttempts;
      await tx
        .update(t)
        .set({ outcome: 'unavailable', decidedAt: now, nextCheckAt: null })
        .where(and(eq(t.accountId, accountId), eq(t.outcome, 'pending')));
      await tx
        .update(t)
        .set({ purgeRequestedAt: now })
        .where(
          and(
            eq(t.accountId, accountId),
            isNull(t.purgeRequestedAt),
            or(isNotNull(t.captureKey), isNotNull(t.jobCiphertext)),
          ),
        );
      await tx
        .update(accounts)
        .set({ verifiedAt: null, updatedAt: now })
        .where(eq(accounts.id, accountId));
    });
  }

  async duePurges(cutoff: Date, now: Date, limit: number): Promise<PurgeDue[]> {
    const t = verificationAttempts;
    const rows = await this.#db
      .select({
        id: t.id,
        accountId: t.accountId,
        captureKey: t.captureKey,
        jobCiphertext: t.jobCiphertext,
        jobNonce: t.jobNonce,
      })
      .from(t)
      .where(
        and(
          or(isNotNull(t.captureKey), isNotNull(t.jobCiphertext)),
          // A running check keeps its capture until it is decided.
          or(
            lte(t.purgeRequestedAt, now),
            and(lte(t.createdAt, cutoff), sql`${t.outcome} <> 'pending'`),
          ),
        ),
      )
      .orderBy(t.createdAt)
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      captureKey: r.captureKey,
      job: sealedJob(r.jobCiphertext, r.jobNonce),
    }));
  }

  async purged(id: string): Promise<void> {
    await this.#db
      .update(verificationAttempts)
      .set({ captureKey: null, jobCiphertext: null, jobNonce: null, purgeRequestedAt: null })
      .where(eq(verificationAttempts.id, id));
  }
}
