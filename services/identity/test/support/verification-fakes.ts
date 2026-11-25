import type { VerificationFailure, VerificationOutcome } from '../../src/db/schema.js';
import {
  type AttemptRecord,
  type CheckDue,
  HISTORY_LIMIT,
  type PurgeDue,
  type SealedJob,
  type VerificationStore,
} from '../../src/verification/verification-store.js';

interface Row {
  id: string;
  accountId: string;
  provider: string;
  outcome: VerificationOutcome;
  failure: VerificationFailure | null;
  job: SealedJob | null;
  captureKey: string | null;
  nextCheckAt: Date | null;
  checks: number;
  reviewRequestedAt: Date | null;
  purgeRequestedAt: Date | null;
  createdAt: Date;
}

/** Same rules as DrizzleVerificationStore, in memory. `verified` stands in for accounts.verified_at. */
export class InMemoryVerificationStore implements VerificationStore {
  readonly rows: Row[] = [];
  readonly verified = new Set<string>();

  constructor(private readonly clock: () => Date) {}

  #row(id: string): Row {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('no such attempt');
    return row;
  }

  recent(accountId: string): Promise<AttemptRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.accountId === accountId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, HISTORY_LIMIT)
        .map((r) => ({
          id: r.id,
          outcome: r.outcome,
          failure: r.failure,
          hasCapture: r.captureKey !== null,
          reviewRequested: r.reviewRequestedAt !== null,
          createdAt: r.createdAt,
        })),
    );
  }

  insertPending(a: { id: string; accountId: string; provider: string; captureKey: string }) {
    this.rows.push({
      ...a,
      outcome: 'pending',
      failure: null,
      job: null,
      nextCheckAt: null,
      checks: 0,
      reviewRequestedAt: null,
      purgeRequestedAt: null,
      createdAt: this.clock(),
    });
    return Promise.resolve();
  }

  accepted(id: string, job: SealedJob, nextCheckAt: Date) {
    const row = this.#row(id);
    if (row.outcome === 'pending') Object.assign(row, { job, nextCheckAt });
    return Promise.resolve();
  }

  dueChecks(now: Date, limit: number): Promise<CheckDue[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.outcome === 'pending' && r.job && r.nextCheckAt && r.nextCheckAt <= now)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          accountId: r.accountId,
          job: r.job as SealedJob,
          checks: r.checks,
          createdAt: r.createdAt,
        })),
    );
  }

  reschedule(id: string, nextCheckAt: Date) {
    const row = this.#row(id);
    row.nextCheckAt = nextCheckAt;
    row.checks += 1;
    return Promise.resolve();
  }

  decide(
    id: string,
    outcome: Exclude<VerificationOutcome, 'pending'>,
    failure: VerificationFailure | null,
    now: Date,
  ) {
    const row = this.#row(id);
    if (row.outcome !== 'pending') return Promise.resolve(false);
    row.outcome = outcome;
    row.failure = outcome === 'failed' ? failure : null;
    row.nextCheckAt = null;
    if (outcome === 'unavailable') row.purgeRequestedAt = now;
    if (outcome === 'passed') this.verified.add(row.accountId);
    return Promise.resolve(true);
  }

  requestReview(id: string, now: Date) {
    const row = this.#row(id);
    const ok =
      row.outcome === 'failed' &&
      !row.reviewRequestedAt &&
      row.captureKey !== null &&
      !row.purgeRequestedAt;
    if (ok) row.reviewRequestedAt = now;
    return Promise.resolve(ok);
  }

  forgetAccount(accountId: string, now: Date) {
    for (const row of this.rows.filter((r) => r.accountId === accountId)) {
      if (row.outcome === 'pending')
        Object.assign(row, { outcome: 'unavailable', nextCheckAt: null });
      if (!row.purgeRequestedAt && (row.captureKey || row.job)) row.purgeRequestedAt = now;
    }
    this.verified.delete(accountId);
    return Promise.resolve();
  }

  duePurges(cutoff: Date, now: Date, limit: number): Promise<PurgeDue[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            (r.captureKey || r.job) &&
            ((r.purgeRequestedAt && r.purgeRequestedAt <= now) ||
              (r.createdAt <= cutoff && r.outcome !== 'pending')),
        )
        .slice(0, limit)
        .map((r) => ({ id: r.id, accountId: r.accountId, captureKey: r.captureKey, job: r.job })),
    );
  }

  purged(id: string) {
    Object.assign(this.#row(id), { captureKey: null, job: null, purgeRequestedAt: null });
    return Promise.resolve();
  }
}
