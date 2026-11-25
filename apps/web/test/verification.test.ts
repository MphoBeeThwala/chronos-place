import { describe, expect, it, vi } from 'vitest';
import {
  biometricConsent,
  CAPTURE_PATH,
  captureBody,
  failureText,
  uploadCapture,
} from '@/lib/verification';

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const view = { status: 'PENDING', failure: null, attemptsRemaining: 4, reviewAvailable: false };
const body = { selfie: 'U0VMRklF', frames: ['QQ==', 'Qg=='] };

describe('captureBody', () => {
  it('takes the selfie (type 2) and the liveness frames (type 6) only', () => {
    expect(
      captureBody({
        images: [
          { image: 'S', image_type_id: 2 },
          { image: 'A', image_type_id: 6 },
          { image: 'B', image_type_id: 6 },
          { image: 'ID', image_type_id: 3 },
        ],
      }),
    ).toEqual({ selfie: 'S', frames: ['A', 'B'] });
  });

  it('refuses an incomplete or odd capture', () => {
    expect(captureBody(undefined)).toBeUndefined();
    expect(captureBody({ images: [{ image: 'S', image_type_id: 2 }] })).toBeUndefined();
    expect(
      captureBody({
        images: [
          { image: 'S', image_type_id: 2 },
          { image: 'T', image_type_id: 2 },
          { image: 'A', image_type_id: 6 },
        ],
      }),
    ).toBeUndefined();
    const tooMany = Array.from({ length: 13 }, () => ({ image: 'A', image_type_id: 6 }));
    expect(captureBody({ images: [{ image: 'S', image_type_id: 2 }, ...tooMany] })).toBeUndefined();
  });
});

describe('uploadCapture', () => {
  it('posts JSON to the same-origin capture path', async () => {
    const fetchFn = vi.fn(() => reply(200, view));
    expect(await uploadCapture(body, () => Promise.resolve('refreshed'), fetchFn)).toEqual({
      ok: true,
      verification: view,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CAPTURE_PATH);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('renews an expired session once and retries', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => reply(401, { error: { code: 'UNAUTHENTICATED' } }))
      .mockImplementationOnce(() => reply(200, view));
    const refresh = vi.fn(() => Promise.resolve('refreshed' as const));
    expect((await uploadCapture(body, refresh, fetchFn)).ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports a session that cannot be renewed as signed out', async () => {
    const fetchFn = vi.fn(() => reply(401, { error: { code: 'UNAUTHENTICATED' } }));
    expect(await uploadCapture(body, () => Promise.resolve('signed-out'), fetchFn)).toMatchObject({
      ok: false,
      signedOut: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shows the gateway's member-facing messages and hides internal ones", async () => {
    const consent = 'Agree to the selfie check before starting it.';
    expect(
      await uploadCapture(
        body,
        () => Promise.resolve('refreshed'),
        () => reply(409, { error: { code: 'FAILED_PRECONDITION', message: consent } }),
      ),
    ).toEqual({ ok: false, code: 'FAILED_PRECONDITION', message: consent });
    expect(
      await uploadCapture(
        body,
        () => Promise.resolve('refreshed'),
        () => reply(500, { error: { code: 'INTERNAL_SERVER_ERROR', message: 'x' } }),
      ),
    ).toMatchObject({ message: 'Something went wrong. Try again.' });
    expect(
      await uploadCapture(
        body,
        () => Promise.resolve('refreshed'),
        () => Promise.reject(new Error('offline')),
      ),
    ).toMatchObject({ ok: false, code: 'NETWORK' });
  });
});

describe('biometricConsent', () => {
  const policies = [{ type: 'BIOMETRIC_VERIFICATION', version: 'bio-v2' }];

  it('needs the latest answer to grant the current version', () => {
    expect(biometricConsent([], policies)).toEqual({ version: 'bio-v2', granted: false });
    expect(
      biometricConsent(
        [{ type: 'BIOMETRIC_VERIFICATION', policyVersion: 'bio-v1', granted: true }],
        policies,
      ).granted,
    ).toBe(false);
    expect(
      biometricConsent(
        [
          { type: 'BIOMETRIC_VERIFICATION', policyVersion: 'bio-v2', granted: true },
          { type: 'BIOMETRIC_VERIFICATION', policyVersion: 'bio-v2', granted: false },
        ],
        policies,
      ).granted,
    ).toBe(false);
    expect(
      biometricConsent(
        [{ type: 'BIOMETRIC_VERIFICATION', policyVersion: 'bio-v2', granted: true }],
        policies,
      ).granted,
    ).toBe(true);
  });
});

describe('failureText', () => {
  it('uses plain, blame-free language', () => {
    for (const f of ['POOR_QUALITY', 'NOT_CONFIRMED', 'UNAVAILABLE', null] as const) {
      expect(failureText(f)).not.toMatch(/fake|fraud|reject|invalid/i);
    }
  });
});
