import type { VerificationFailure } from '../db/schema.js';
import type { LivenessCapture } from './capture.js';

export type ProviderResult =
  | { state: 'pending' }
  | { state: 'passed' }
  | { state: 'failed'; failure: VerificationFailure }
  /** The vendor could not complete the check. Does not count as a failed attempt. */
  | { state: 'unavailable' };

/**
 * A liveness vendor (ADR-0022). Smile ID in production, behind this interface so it can be
 * replaced without touching clients. Implementations receive only the capture and a random
 * reference: never the account id, phone number, name, date of birth or anything health-related.
 */
export interface LivenessProvider {
  /** Stored with each attempt, e.g. "smile-id". */
  readonly name: string;
  /** Sends a capture. Returns the vendor's job id. */
  submit(reference: string, capture: LivenessCapture): Promise<{ jobId: string }>;
  result(jobId: string): Promise<ProviderResult>;
  /** Asks the vendor to delete its copy of the job's images. Idempotent. */
  forget(jobId: string): Promise<void>;
}

/**
 * Development and test provider. Passes every capture unless outcomes are queued. Records what it
 * was sent so tests can prove the vendor never learns who the member is.
 */
export class FakeLivenessProvider implements LivenessProvider {
  readonly name = 'fake';
  readonly submitted: { reference: string; capture: LivenessCapture }[] = [];
  readonly forgotten: string[] = [];
  readonly #outcomes: ProviderResult[] = [];
  readonly #results = new Map<string, ProviderResult>();
  /** When set, submit throws this error (vendor down). */
  failSubmit: Error | undefined;

  /** Results for the next submissions, in order. */
  queue(...outcomes: ProviderResult[]): void {
    this.#outcomes.push(...outcomes);
  }

  submit(reference: string, capture: LivenessCapture): Promise<{ jobId: string }> {
    if (this.failSubmit) return Promise.reject(this.failSubmit);
    this.submitted.push({ reference, capture });
    const jobId = `fake-job-${String(this.submitted.length)}`;
    this.#results.set(jobId, this.#outcomes.shift() ?? { state: 'passed' });
    return Promise.resolve({ jobId });
  }

  result(jobId: string): Promise<ProviderResult> {
    return Promise.resolve(this.#results.get(jobId) ?? { state: 'unavailable' });
  }

  /** Settles a job that was queued as pending. */
  settle(jobId: string, result: ProviderResult): void {
    this.#results.set(jobId, result);
  }

  forget(jobId: string): Promise<void> {
    this.forgotten.push(jobId);
    return Promise.resolve();
  }
}
