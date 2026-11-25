import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { JOB_FIELD } from './capture.js';
import type { CaptureStore } from './capture-store.js';
import type { LivenessProvider } from './provider.js';
import type { SealedJob, VerificationStore } from './verification-store.js';

/** Captures are kept this long for appeals, then deleted with the vendor's copy (ADR-0022). */
export const CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A check the vendor has not answered within this time is given up as "unavailable". */
export const CHECK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_CHECK_DELAY_MS = 5 * 60 * 1000;
const BATCH = 25;

export interface VerificationWorkerDeps {
  store: VerificationStore;
  captures: CaptureStore;
  provider: LivenessProvider;
  keyring: SubjectKeyring;
  logger: Logger;
  now?: () => Date;
}

/** Backoff between result checks: 5 s, 10 s, 20 s … capped at 5 minutes. */
export const nextCheckDelay = (checks: number): number =>
  Math.min(MAX_CHECK_DELAY_MS, 5_000 * 2 ** Math.min(checks + 1, 16));

/**
 * Background work for liveness checks: asks the vendor for results, then deletes captures and
 * the vendor's copies when they are 30 days old or a purge was requested. Safe to run on several
 * replicas: a result is recorded only while the attempt is still pending, and deletion is
 * idempotent at both ends.
 */
export class VerificationWorker {
  readonly #d: Required<VerificationWorkerDeps>;

  constructor(deps: VerificationWorkerDeps) {
    this.#d = { now: () => new Date(), ...deps };
  }

  async runOnce(): Promise<void> {
    await this.checkResults();
    await this.purge();
  }

  async checkResults(): Promise<void> {
    const now = this.#d.now();
    for (const due of await this.#d.store.dueChecks(now, BATCH)) {
      try {
        if (now.getTime() - due.createdAt.getTime() > CHECK_TIMEOUT_MS) {
          await this.#d.store.decide(due.id, 'unavailable', null, now);
          this.#d.logger.warn({ attemptId: due.id }, 'liveness check timed out');
          continue;
        }
        const result = await this.#d.provider.result(await this.#job(due.accountId, due.job));
        if (result.state === 'pending') {
          await this.#d.store.reschedule(
            due.id,
            new Date(now.getTime() + nextCheckDelay(due.checks)),
          );
          continue;
        }
        const failure = result.state === 'failed' ? result.failure : null;
        if (await this.#d.store.decide(due.id, result.state, failure, now)) {
          this.#d.logger.info(
            { accountId: due.accountId, attemptId: due.id, outcome: result.state },
            'liveness check decided',
          );
        }
      } catch (err) {
        await this.#d.store.reschedule(
          due.id,
          new Date(now.getTime() + nextCheckDelay(due.checks)),
        );
        this.#d.logger.warn({ attemptId: due.id, err }, 'liveness result check failed');
      }
    }
  }

  async purge(): Promise<void> {
    const now = this.#d.now();
    const cutoff = new Date(now.getTime() - CAPTURE_RETENTION_MS);
    for (const due of await this.#d.store.duePurges(cutoff, now, BATCH)) {
      try {
        if (due.captureKey) await this.#d.captures.delete(due.captureKey);
        // An erased account's key is shredded, so its vendor job id cannot be read any more.
        // Account erasure asks the vendor to delete by reference instead (M1.8).
        const jobId = due.job
          ? await this.#job(due.accountId, due.job).catch(() => undefined)
          : undefined;
        if (jobId) await this.#d.provider.forget(jobId);
        await this.#d.store.purged(due.id);
        this.#d.logger.info({ attemptId: due.id }, 'verification capture deleted');
      } catch (err) {
        this.#d.logger.warn({ attemptId: due.id, err }, 'verification capture deletion failed');
      }
    }
  }

  async #job(accountId: string, job: SealedJob): Promise<string> {
    return String(await this.#d.keyring.decrypt(accountId, JOB_FIELD, job));
  }
}
