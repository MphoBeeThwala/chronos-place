/**
 * Test doubles. Import from "@chronos/crypto/testing". Never use these to hold real data:
 * the in-memory wrapper refuses to start in production.
 */
import { randomBytes } from 'node:crypto';
import { buildAad, NONCE_LENGTH, open, seal } from './cipher.js';
import { CryptoError, KeyUnwrapError } from './errors.js';
import {
  encryptionContext,
  type GeneratedKey,
  type KeyContext,
  type KeyWrapper,
} from './key-wrapper.js';
import type { ShredLedger, WrappedKeyRecord, WrappedKeyStore } from './keyring.js';

const contextAad = (context: KeyContext): Uint8Array =>
  buildAad(JSON.stringify(encryptionContext(context)), 'wrapped-key');

export class InMemoryKeyWrapper implements KeyWrapper {
  readonly #master = randomBytes(32);

  constructor() {
    if (process.env['NODE_ENV'] === 'production')
      throw new CryptoError('Test key wrapper is not allowed in production');
  }

  #wrap(plaintext: Uint8Array, context: KeyContext): Uint8Array {
    const { nonce, ciphertext } = seal(this.#master, plaintext, contextAad(context));
    return Buffer.concat([nonce, ciphertext]);
  }

  generateDataKey(context: KeyContext): Promise<GeneratedKey> {
    const plaintext = randomBytes(32);
    return Promise.resolve({
      plaintext,
      wrapped: this.#wrap(plaintext, context),
      keyId: 'in-memory',
    });
  }

  unwrap(wrapped: Uint8Array, context: KeyContext): Promise<Uint8Array> {
    try {
      const nonce = wrapped.subarray(0, NONCE_LENGTH);
      const ciphertext = wrapped.subarray(NONCE_LENGTH);
      return Promise.resolve(open(this.#master, { nonce, ciphertext }, contextAad(context)));
    } catch {
      return Promise.reject(new KeyUnwrapError());
    }
  }

  async rewrap(
    wrapped: Uint8Array,
    context: KeyContext,
  ): Promise<{ wrapped: Uint8Array; keyId: string }> {
    const plaintext = await this.unwrap(wrapped, context);
    const out = { wrapped: this.#wrap(plaintext, context), keyId: 'in-memory' };
    plaintext.fill(0);
    return out;
  }
}

export class InMemoryWrappedKeyStore implements WrappedKeyStore {
  #records = new Map<string, WrappedKeyRecord>();

  get(subjectId: string): Promise<WrappedKeyRecord | undefined> {
    return Promise.resolve(this.#records.get(subjectId));
  }

  putIfAbsent(subjectId: string, record: WrappedKeyRecord): Promise<boolean> {
    if (this.#records.has(subjectId)) return Promise.resolve(false);
    this.#records.set(subjectId, record);
    return Promise.resolve(true);
  }

  replace(subjectId: string, record: WrappedKeyRecord): Promise<void> {
    this.#records.set(subjectId, record);
    return Promise.resolve();
  }

  delete(subjectId: string): Promise<void> {
    this.#records.delete(subjectId);
    return Promise.resolve();
  }

  /** Copies current contents, like a database backup. */
  snapshot(): Map<string, WrappedKeyRecord> {
    return new Map(this.#records);
  }

  /** Replaces contents with a snapshot, like restoring a backup. */
  restore(snapshot: ReadonlyMap<string, WrappedKeyRecord>): void {
    this.#records = new Map(snapshot);
  }
}

export class InMemoryShredLedger implements ShredLedger {
  readonly #ids = new Set<string>();

  isShredded(subjectId: string): Promise<boolean> {
    return Promise.resolve(this.#ids.has(subjectId));
  }

  record(subjectId: string): Promise<void> {
    this.#ids.add(subjectId);
    return Promise.resolve();
  }
}
