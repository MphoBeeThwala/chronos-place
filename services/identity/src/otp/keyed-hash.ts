import { createHmac } from 'node:crypto';

/**
 * Keyed hashes (HMAC-SHA256) for values that must be matched but never stored or used in cache
 * keys in the clear: phone numbers, IP addresses, device ids (ADR-0018). Each purpose is
 * domain-separated, so the same input gives unrelated hashes for different uses.
 */
export type HashPurpose = 'phone' | 'ip' | 'device';

export class KeyedHasher {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length < 32) throw new Error('keyed hash key must be at least 32 bytes');
    this.#key = Buffer.from(key);
  }

  hash(purpose: HashPurpose, value: string): Buffer {
    return createHmac('sha256', this.#key).update(`${purpose}\0${value}`).digest();
  }
}
