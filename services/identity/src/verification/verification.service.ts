import { randomUUID } from 'node:crypto';
import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import type { AccountRecord } from '../accounts/account-store.js';
import type { VerificationFailure } from '../db/schema.js';
import {
  assertValidCapture,
  captureField,
  captureKey,
  encodeCapture,
  JOB_FIELD,
  type LivenessCapture,
} from './capture.js';
import type { CaptureStore } from './capture-store.js';
import type { LivenessProvider } from './provider.js';
import type { AttemptRecord, VerificationStore } from './verification-store.js';

/** Approved limits (ADR-0022 decision f). They also protect the prepaid vendor wallet. */
export const ATTEMPTS_PER_HOUR = 5;
export const ATTEMPTS_PER_DAY = 10;
/** Failed attempts before a member may ask for a person to review (ADR-0022 decision d). */
export const FAILURES_BEFORE_REVIEW = 3;
/** First time the worker asks the vendor for a result. */
export const FIRST_CHECK_DELAY_MS = 5_000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ACCOUNT_NOT_READY = 'Finish signing up before verifying your profile.';
const ALREADY_VERIFIED = 'Your profile is already verified.';
const IN_PROGRESS = 'A check is already running.';
const NEEDS_CONSENT = 'Agree to the selfie check before starting it.';
const LIMIT_REACHED = 'You have used all your attempts for now. Please try again later.';
const NOT_AVAILABLE = 'Verification is not available right now.';
const NO_REVIEW = 'A review is not available for this check.';

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'failed' | 'in_review';

export interface VerificationView {
  status: VerificationStatus;
  /** Set when status is "failed". "unavailable" means the check could not be completed. */
  failure: VerificationFailure | 'unavailable' | null;
  attemptsRemaining: number;
  reviewAvailable: boolean;
}

export interface VerificationServiceDeps {
  store: VerificationStore;
  captures: CaptureStore;
  /** Undefined where no vendor may run (outside development until the adapter and counsel sign-off). */
  provider: LivenessProvider | undefined;
  keyring: SubjectKeyring;
  getAccount: (accountId: string) => Promise<AccountRecord>;
  /** True when the biometric verification consent is granted at its current version. */
  hasConsent: (accountId: string) => Promise<boolean>;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Selfie liveness checks (TASKS M1.4, ADR-0022). The capture is sealed under the account key
 * before it is stored, and the vendor is sent only the images and a random reference (the
 * attempt id). Logs carry ids and outcomes, never images or vendor job ids.
 */
export class VerificationService {
  readonly #d: Required<Omit<VerificationServiceDeps, 'provider'>> & {
    provider: LivenessProvider | undefined;
  };

  constructor(deps: VerificationServiceDeps) {
    this.#d = { now: () => new Date(), newId: randomUUID, ...deps };
  }

  async get(accountId: string): Promise<VerificationView> {
    const account = await this.#d.getAccount(accountId);
    return this.#view(account, await this.#d.store.recent(accountId));
  }

  async submit(accountId: string, capture: LivenessCapture): Promise<VerificationView> {
    const { provider } = this.#d;
    if (!provider) throw new DomainError('unavailable', NOT_AVAILABLE);
    const account = await this.#d.getAccount(accountId);
    if (account.status !== 'active')
      throw new DomainError('failed_precondition', ACCOUNT_NOT_READY);
    if (account.verified) throw new DomainError('failed_precondition', ALREADY_VERIFIED);
    const recent = await this.#d.store.recent(accountId);
    if (recent[0]?.outcome === 'pending') throw new DomainError('failed_precondition', IN_PROGRESS);
    if (this.#remaining(recent) === 0) throw new DomainError('resource_exhausted', LIMIT_REACHED);
    if (!(await this.#d.hasConsent(accountId))) {
      throw new DomainError('failed_precondition', NEEDS_CONSENT);
    }
    assertValidCapture(capture);

    const attemptId = this.#d.newId();
    const key = captureKey(attemptId);
    const sealed = await this.#d.keyring.encrypt(
      accountId,
      captureField(attemptId),
      encodeCapture(capture),
    );
    await this.#d.captures.put(key, Buffer.concat([sealed.nonce, sealed.ciphertext]));
    await this.#d.store.insertPending({
      id: attemptId,
      accountId,
      provider: provider.name,
      captureKey: key,
    });

    try {
      const { jobId } = await provider.submit(attemptId, capture);
      const job = await this.#d.keyring.encrypt(accountId, JOB_FIELD, jobId);
      await this.#d.store.accepted(
        attemptId,
        { ciphertext: Buffer.from(job.ciphertext), nonce: Buffer.from(job.nonce) },
        new Date(this.#d.now().getTime() + FIRST_CHECK_DELAY_MS),
      );
      this.#d.logger.info({ accountId, attemptId }, 'liveness capture submitted');
    } catch (err) {
      // The vendor never got it: nothing to wait for and nothing worth keeping.
      await this.#d.store.decide(attemptId, 'unavailable', null, this.#d.now());
      this.#d.logger.warn({ accountId, attemptId, err }, 'liveness provider refused capture');
    }
    return this.get(accountId);
  }

  async requestReview(accountId: string): Promise<VerificationView> {
    const account = await this.#d.getAccount(accountId);
    const recent = await this.#d.store.recent(accountId);
    const latest = recent[0];
    if (!latest || !this.#reviewAvailable(account, recent)) {
      throw new DomainError('failed_precondition', NO_REVIEW);
    }
    if (!(await this.#d.store.requestReview(latest.id, this.#d.now()))) {
      throw new DomainError('failed_precondition', NO_REVIEW);
    }
    this.#d.logger.info({ accountId, attemptId: latest.id }, 'verification review requested');
    return this.get(accountId);
  }

  /** Biometric consent withdrawn (ADR-0022 decision 10). The worker then deletes the copies. */
  async forget(accountId: string): Promise<void> {
    await this.#d.store.forgetAccount(accountId, this.#d.now());
    this.#d.logger.info({ accountId }, 'verification data scheduled for deletion');
  }

  #remaining(recent: readonly AttemptRecord[]): number {
    const now = this.#d.now().getTime();
    const since = (ms: number) => recent.filter((a) => now - a.createdAt.getTime() < ms).length;
    return Math.max(
      0,
      Math.min(ATTEMPTS_PER_HOUR - since(HOUR_MS), ATTEMPTS_PER_DAY - since(DAY_MS)),
    );
  }

  #reviewAvailable(account: AccountRecord, recent: readonly AttemptRecord[]): boolean {
    const latest = recent[0];
    return (
      !account.verified &&
      latest?.outcome === 'failed' &&
      latest.hasCapture &&
      !latest.reviewRequested &&
      recent.filter((a) => a.outcome === 'failed').length >= FAILURES_BEFORE_REVIEW
    );
  }

  #view(account: AccountRecord, recent: readonly AttemptRecord[]): VerificationView {
    const latest = recent[0];
    const base = {
      attemptsRemaining: account.verified ? 0 : this.#remaining(recent),
      reviewAvailable: this.#reviewAvailable(account, recent),
      failure: null,
    };
    if (account.verified) return { ...base, status: 'verified' };
    switch (latest?.outcome) {
      case 'pending':
        return { ...base, status: 'pending' };
      case 'failed':
        return latest.reviewRequested
          ? { ...base, status: 'in_review' }
          : { ...base, status: 'failed', failure: latest.failure ?? 'not_confirmed' };
      case 'unavailable':
        return { ...base, status: 'failed', failure: 'unavailable' };
      default:
        return { ...base, status: 'unverified' };
    }
  }
}
