import { createHmac, randomInt } from 'node:crypto';
import { constantTimeEqual } from '@chronos/crypto';

export const CODE_LENGTH = 6;
const CODE_FORMAT = /^\d{6}$/;

/** A uniformly random 6-digit code. */
export function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}

export function isWellFormedCode(code: string): boolean {
  return CODE_FORMAT.test(code);
}

/**
 * Codes are stored only as HMAC-SHA256 over the challenge id and the code, under a server key.
 * Without the key, a copy of the database does not let anyone try the million codes offline.
 */
export class CodeHasher {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length < 32) throw new Error('code hash key must be at least 32 bytes');
    this.#key = Buffer.from(key);
  }

  hash(challengeId: string, code: string): Buffer {
    return createHmac('sha256', this.#key).update(`${challengeId}\0${code}`).digest();
  }

  /** Constant-time check of a submitted code against the stored hash. */
  matches(challengeId: string, code: string, stored: Uint8Array): boolean {
    return constantTimeEqual(this.hash(challengeId, code), stored);
  }
}
