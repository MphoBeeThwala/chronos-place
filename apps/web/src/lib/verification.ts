import type { RefreshOutcome } from './session-refresh';

/**
 * Selfie verification in the browser (ADR-0022). The capture component hands us the images; we
 * post them to our own gateway, never to the vendor. Nothing here is stored in the browser.
 */
export const CAPTURE_PATH = '/api/verification/capture';
export const BIOMETRIC_CONSENT = 'BIOMETRIC_VERIFICATION';

/** Smile ID's image types: 2 is the selfie, 6 a liveness frame. ID documents are never captured. */
const SELFIE = 2;
const LIVENESS_FRAME = 6;
const MAX_FRAMES = 12;

/** `event.detail` of the component's `imagesComputed` event. */
export interface ComputedImages {
  images?: { image?: unknown; image_type_id?: unknown }[];
}

export interface CaptureBody {
  selfie: string;
  frames: string[];
}

/** The selfie plus its liveness frames, or undefined when the capture is incomplete. */
export function captureBody(detail: ComputedImages | null | undefined): CaptureBody | undefined {
  const images = (detail?.images ?? []).filter(
    (i): i is { image: string; image_type_id: number } => typeof i.image === 'string',
  );
  const selfies = images.filter((i) => i.image_type_id === SELFIE);
  const frames = images.filter((i) => i.image_type_id === LIVENESS_FRAME).map((i) => i.image);
  const [selfie] = selfies;
  if (selfies.length !== 1 || !selfie || frames.length === 0 || frames.length > MAX_FRAMES) {
    return undefined;
  }
  return { selfie: selfie.image, frames };
}

export interface VerificationView {
  status: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'IN_REVIEW';
  failure: 'POOR_QUALITY' | 'NOT_CONFIRMED' | 'UNAVAILABLE' | null;
  attemptsRemaining: number;
  reviewAvailable: boolean;
}

export type UploadResult =
  | { ok: true; verification: VerificationView }
  | { ok: false; code: string; message: string; signedOut?: boolean };

const FALLBACK = 'Something went wrong. Try again.';

/**
 * Posts one capture. An expired access cookie is renewed once and the upload retried, as the
 * Apollo link does for GraphQL.
 */
export async function uploadCapture(
  body: CaptureBody,
  refresh: () => Promise<RefreshOutcome>,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<UploadResult> {
  const send = () =>
    fetchFn(CAPTURE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    let response = await send();
    if (response.status === 401) {
      if ((await refresh()) === 'signed-out') {
        return {
          ok: false,
          code: 'UNAUTHENTICATED',
          message: 'Sign in to continue.',
          signedOut: true,
        };
      }
      response = await send();
    }
    const json = (await response.json()) as VerificationView & {
      error?: { code?: string; message?: string };
    };
    if (response.ok) return { ok: true, verification: json };
    const code = json.error?.code ?? 'INTERNAL_SERVER_ERROR';
    return {
      ok: false,
      code,
      message: code === 'INTERNAL_SERVER_ERROR' ? FALLBACK : (json.error?.message ?? FALLBACK),
      ...(code === 'UNAUTHENTICATED' ? { signedOut: true } : {}),
    };
  } catch {
    return { ok: false, code: 'NETWORK', message: FALLBACK };
  }
}

interface ConsentEntry {
  type: string;
  policyVersion: string;
  granted: boolean;
}

/** The current biometric policy version, and whether the member's latest answer grants it. */
export function biometricConsent(
  consents: readonly ConsentEntry[],
  policies: readonly { type: string; version: string }[],
): { version: string | undefined; granted: boolean } {
  const version = policies.find((p) => p.type === BIOMETRIC_CONSENT)?.version;
  const latest = consents.filter((c) => c.type === BIOMETRIC_CONSENT).at(-1);
  return { version, granted: latest?.granted === true && latest.policyVersion === version };
}

/** Plain-language text for a failed check (person-first, no blame). */
export function failureText(failure: VerificationView['failure']): string {
  switch (failure) {
    case 'POOR_QUALITY':
      return 'The photos were too dark or blurred, or your face was not clear. Try again in good light, facing the camera.';
    case 'NOT_CONFIRMED':
      return 'We could not confirm the check this time. You can try again.';
    case 'UNAVAILABLE':
      return 'The check could not be completed. This does not count against you. Please try again.';
    default:
      return 'The check did not pass. You can try again.';
  }
}
