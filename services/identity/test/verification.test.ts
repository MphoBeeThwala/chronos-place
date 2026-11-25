import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { captureField, decodeCapture, type LivenessCapture } from '../src/verification/capture.js';
import { CAPTURE_RETENTION_MS, CHECK_TIMEOUT_MS } from '../src/verification/verification-worker.js';
import { ACCOUNT, capture, jpeg, setup } from './support/verification-harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('submitting a liveness capture', () => {
  it('seals the capture, sends the vendor only a random reference and verifies on a pass', async () => {
    const h = setup();
    expect((await h.service.submit(ACCOUNT, capture())).status).toBe('pending');

    const [sent] = h.provider.submitted;
    expect(sent?.reference).not.toBe(ACCOUNT);
    expect(sent?.reference).toBe(h.store.rows[0]?.id);

    const [stored] = [...h.captures.objects.values()];
    expect(stored?.includes(jpeg('S'))).toBe(false);
    const attemptId = h.store.rows[0]?.id ?? '';
    const opened = decodeCapture(
      await h.keyring.decrypt(ACCOUNT, captureField(attemptId), {
        nonce: stored?.subarray(0, 12) ?? Buffer.alloc(0),
        ciphertext: stored?.subarray(12) ?? Buffer.alloc(0),
      }),
    );
    expect(opened.selfie.equals(jpeg('S'))).toBe(true);
    expect(h.store.rows[0]?.job?.ciphertext.includes(Buffer.from('fake-job'))).toBe(false);

    h.advance(5_000);
    await h.worker.runOnce();
    expect(await h.service.get(ACCOUNT)).toMatchObject({
      status: 'verified',
      attemptsRemaining: 0,
    });
    expect(h.store.verified.has(ACCOUNT)).toBe(true);
  });

  it('refuses before onboarding is finished, without consent, or once verified', async () => {
    expect(
      (
        await domainError(
          setup({ status: 'pending_onboarding' }).service.submit(ACCOUNT, capture()),
        )
      ).code,
    ).toBe('failed_precondition');
    const noConsent = setup({ consent: false });
    expect((await domainError(noConsent.service.submit(ACCOUNT, capture()))).code).toBe(
      'failed_precondition',
    );
    expect(noConsent.provider.submitted).toHaveLength(0);

    const h = setup();
    await h.service.submit(ACCOUNT, capture());
    h.advance(5_000);
    await h.worker.runOnce();
    expect((await domainError(h.service.submit(ACCOUNT, capture()))).code).toBe(
      'failed_precondition',
    );
  });

  it('allows one running check at a time', async () => {
    const h = setup();
    h.provider.queue({ state: 'pending' });
    await h.service.submit(ACCOUNT, capture());
    expect((await domainError(h.service.submit(ACCOUNT, capture()))).code).toBe(
      'failed_precondition',
    );
  });

  it('rejects anything but a selfie plus 1–12 JPEG frames within 3 MB', async () => {
    const h = setup();
    const bad: LivenessCapture[] = [
      { selfie: jpeg('S'), frames: [] },
      { selfie: Buffer.from('not a jpeg'), frames: [jpeg('A')] },
      { selfie: jpeg('S'), frames: Array.from({ length: 13 }, () => jpeg('A', 10)) },
      { selfie: jpeg('S', 3 * 1024 * 1024), frames: [jpeg('A')] },
    ];
    for (const c of bad)
      expect((await domainError(h.service.submit(ACCOUNT, c))).code).toBe('invalid_argument');
    expect(h.provider.submitted).toHaveLength(0);
  });

  it('applies 5 attempts an hour and 10 a day (ADR-0022 decision f)', async () => {
    const h = setup();
    h.provider.queue(
      ...Array.from({ length: 10 }, () => ({
        state: 'failed' as const,
        failure: 'poor_quality' as const,
      })),
    );
    const attempt = async () => {
      await h.service.submit(ACCOUNT, capture());
      h.advance(5_000);
      await h.worker.runOnce();
    };
    for (let i = 0; i < 5; i += 1) await attempt();
    expect((await h.service.get(ACCOUNT)).attemptsRemaining).toBe(0);
    expect((await domainError(h.service.submit(ACCOUNT, capture()))).code).toBe(
      'resource_exhausted',
    );

    h.advance(HOUR);
    for (let i = 0; i < 5; i += 1) await attempt();
    h.advance(HOUR);
    expect((await domainError(h.service.submit(ACCOUNT, capture()))).code).toBe(
      'resource_exhausted',
    );
    h.advance(24 * HOUR);
    expect((await h.service.get(ACCOUNT)).attemptsRemaining).toBe(5);
  });

  it('answers UNAVAILABLE where no vendor may run', async () => {
    expect(
      (await domainError(setup({ provider: false }).service.submit(ACCOUNT, capture()))).code,
    ).toBe('unavailable');
  });

  it('treats a vendor that refuses the capture as "could not be completed" and drops the capture', async () => {
    const h = setup();
    h.provider.failSubmit = new Error('vendor down');
    expect(await h.service.submit(ACCOUNT, capture())).toMatchObject({
      status: 'failed',
      failure: 'unavailable',
    });
    await h.worker.runOnce();
    expect(h.captures.objects.size).toBe(0);
  });
});

describe('results', () => {
  it('reports a coarse failure reason only', async () => {
    const h = setup();
    h.provider.queue({ state: 'failed', failure: 'poor_quality' });
    await h.service.submit(ACCOUNT, capture());
    h.advance(5_000);
    await h.worker.runOnce();
    expect(await h.service.get(ACCOUNT)).toMatchObject({
      status: 'failed',
      failure: 'poor_quality',
    });
  });

  it('keeps asking with backoff while the vendor is busy, and gives up after 24 hours', async () => {
    const h = setup();
    h.provider.queue({ state: 'pending' });
    await h.service.submit(ACCOUNT, capture());
    h.advance(5_000);
    await h.worker.runOnce();
    expect(h.store.rows[0]?.checks).toBe(1);
    expect(h.store.rows[0]?.nextCheckAt?.getTime()).toBe(
      Date.parse('2026-11-25T10:00:05Z') + 10_000,
    );

    h.advance(CHECK_TIMEOUT_MS);
    await h.worker.runOnce();
    expect(await h.service.get(ACCOUNT)).toMatchObject({
      status: 'failed',
      failure: 'unavailable',
    });
  });
});

describe('human review (ADR-0022 decision d)', () => {
  it('is offered after 3 failed attempts and keeps the capture for the reviewer', async () => {
    const h = setup();
    h.provider.queue(
      ...Array.from({ length: 3 }, () => ({
        state: 'failed' as const,
        failure: 'not_confirmed' as const,
      })),
    );
    for (let i = 0; i < 3; i += 1) {
      expect((await h.service.get(ACCOUNT)).reviewAvailable).toBe(false);
      await h.service.submit(ACCOUNT, capture());
      h.advance(5_000);
      await h.worker.runOnce();
    }
    expect((await h.service.get(ACCOUNT)).reviewAvailable).toBe(true);
    expect(await h.service.requestReview(ACCOUNT)).toMatchObject({
      status: 'in_review',
      reviewAvailable: false,
    });
    expect((await domainError(h.service.requestReview(ACCOUNT))).code).toBe('failed_precondition');
    expect(h.captures.objects.size).toBe(3);
  });

  it('is refused before 3 failures', async () => {
    const h = setup();
    h.provider.queue({ state: 'failed', failure: 'not_confirmed' });
    await h.service.submit(ACCOUNT, capture());
    h.advance(5_000);
    await h.worker.runOnce();
    expect((await domainError(h.service.requestReview(ACCOUNT))).code).toBe('failed_precondition');
  });
});

describe('deleting captures (M1.4 AC: selfie retention job deletes images)', () => {
  it('deletes the capture and asks the vendor to delete its copy after 30 days', async () => {
    const h = setup();
    await h.service.submit(ACCOUNT, capture());
    h.advance(5_000);
    await h.worker.runOnce();
    h.advance(CAPTURE_RETENTION_MS - 10_000);
    await h.worker.runOnce();
    expect(h.captures.objects.size).toBe(1);
    expect(h.provider.forgotten).toHaveLength(0);

    h.advance(10_000);
    await h.worker.runOnce();
    expect(h.captures.objects.size).toBe(0);
    expect(h.provider.forgotten).toEqual(['fake-job-1']);
    expect(h.store.rows[0]).toMatchObject({ captureKey: null, job: null, outcome: 'passed' });
    expect((await h.service.get(ACCOUNT)).status).toBe('verified');
  });

  it('deletes everything at once when the biometric consent is withdrawn, and removes the badge', async () => {
    const h = setup();
    await h.service.submit(ACCOUNT, capture());
    h.advance(5_000);
    await h.worker.runOnce();
    h.withdrawConsent();
    await h.service.forget(ACCOUNT);
    await h.worker.runOnce();
    expect(h.captures.objects.size).toBe(0);
    expect(h.provider.forgotten).toEqual(['fake-job-1']);
    expect((await h.service.get(ACCOUNT)).status).toBe('unverified');
  });

  it('ends a running check when consent is withdrawn', async () => {
    const h = setup();
    h.provider.queue({ state: 'pending' });
    await h.service.submit(ACCOUNT, capture());
    await h.service.forget(ACCOUNT);
    h.provider.settle('fake-job-1', { state: 'passed' });
    h.advance(MINUTE);
    await h.worker.runOnce();
    expect(h.store.verified.has(ACCOUNT)).toBe(false);
    expect(h.captures.objects.size).toBe(0);
  });
});
