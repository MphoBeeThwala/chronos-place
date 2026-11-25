import { DomainError } from '@chronos/service-kit';

/** One capture from the web capture component (ADR-0022). Never logged. */
export interface LivenessCapture {
  selfie: Buffer;
  frames: Buffer[];
}

export const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
export const MAX_LIVENESS_FRAMES = 12;

const INVALID_CAPTURE = 'The photos could not be read. Please try again.';
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const isJpeg = (image: Buffer) => image.length > 3 && image.subarray(0, 3).equals(JPEG_MAGIC);

/** Rejects anything that is not a selfie plus 1–12 JPEG frames within the size cap. */
export function assertValidCapture(capture: LivenessCapture): void {
  const images = [capture.selfie, ...capture.frames];
  const total = images.reduce((n, image) => n + image.length, 0);
  if (
    capture.frames.length === 0 ||
    capture.frames.length > MAX_LIVENESS_FRAMES ||
    total > MAX_CAPTURE_BYTES ||
    !images.every(isJpeg)
  ) {
    throw new DomainError('invalid_argument', INVALID_CAPTURE);
  }
}

/** Field name binding a sealed capture to its attempt (AAD), so captures cannot be swapped. */
export const captureField = (attemptId: string) => `verification-capture:${attemptId}`;
export const JOB_FIELD = 'verification-job';

/** Object key for a capture. Holds only the random attempt id: nothing about the member. */
export const captureKey = (attemptId: string) => `verification/${attemptId}`;

export const encodeCapture = (capture: LivenessCapture) => ({
  selfie: capture.selfie.toString('base64'),
  frames: capture.frames.map((f) => f.toString('base64')),
});

export function decodeCapture(value: unknown): LivenessCapture {
  const v = value as { selfie: string; frames: string[] };
  return {
    selfie: Buffer.from(v.selfie, 'base64'),
    frames: v.frames.map((f) => Buffer.from(f, 'base64')),
  };
}
