import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality for secrets (tokens, MACs, hashes). Inputs of different length compare
 * unequal without leaking where they differ: both sides are MAC'd under a random key first.
 */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const key = randomBytes(32);
  const digest = (value: Uint8Array | string): Buffer =>
    createHmac('sha256', key).update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
