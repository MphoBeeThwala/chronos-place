import { buildAad, openJson, sealJson, type Sealed } from './cipher.js';
import { CryptoError, KeyDestroyedError } from './errors.js';
import type { KeyContext, KeyWrapper } from './key-wrapper.js';

export interface WrappedKeyRecord {
  wrapped: Uint8Array;
  keyId: string;
}

/** Where wrapped keys live. In the vault this is the `subject_keys` table. */
export interface WrappedKeyStore {
  get(subjectId: string): Promise<WrappedKeyRecord | undefined>;
  /** Stores the record only if none exists. Returns false when one is already there. */
  putIfAbsent(subjectId: string, record: WrappedKeyRecord): Promise<boolean>;
  replace(subjectId: string, record: WrappedKeyRecord): Promise<void>;
  delete(subjectId: string): Promise<void>;
}

/**
 * Append-only record of erased subjects, kept outside database backups (ADR-0014).
 * It stops a restored backup from bringing erased data back: a listed subject's key is never unwrapped.
 */
export interface ShredLedger {
  isShredded(subjectId: string): Promise<boolean>;
  record(subjectId: string): Promise<void>;
}

export interface KeyringOptions {
  wrapper: KeyWrapper;
  store: WrappedKeyStore;
  ledger?: ShredLedger;
  /** KMS encryption-context purpose. Defaults to "vault". */
  purpose?: string;
  /** How long a plaintext key may stay in memory. Maximum 60 000 (spec 4.4); 0 disables caching. */
  cacheTtlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export const MAX_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  key: Uint8Array;
  expiresAt: number;
}

/**
 * Per-subject envelope encryption. Each subject has one data key, wrapped by the master key and
 * stored in `store`. Deleting that record (`shred`) makes every ciphertext for the subject unrecoverable.
 */
export class SubjectKeyring {
  readonly #wrapper: KeyWrapper;
  readonly #store: WrappedKeyStore;
  readonly #ledger: ShredLedger | undefined;
  readonly #purpose: string;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<Uint8Array>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: KeyringOptions) {
    const ttl = options.cacheTtlMs ?? MAX_CACHE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl < 0 || ttl > MAX_CACHE_TTL_MS)
      throw new CryptoError('Invalid cache TTL');
    this.#wrapper = options.wrapper;
    this.#store = options.store;
    this.#ledger = options.ledger;
    this.#purpose = options.purpose ?? 'vault';
    this.#ttl = ttl;
    this.#now = options.now ?? Date.now;
  }

  /** Encrypts `value` for `subjectId`, creating the subject's key on first use. */
  async encrypt(subjectId: string, field: string, value: unknown): Promise<Sealed> {
    return this.#withKey(subjectId, true, (key) =>
      sealJson(key, value, buildAad(subjectId, field)),
    );
  }

  /** Decrypts a value. Throws `KeyDestroyedError` if the subject's key is gone. */
  async decrypt(subjectId: string, field: string, sealed: Sealed): Promise<unknown> {
    return this.#withKey(subjectId, false, (key) =>
      openJson(key, sealed, buildAad(subjectId, field)),
    );
  }

  /**
   * Crypto-shred: records the subject in the ledger (if any), deletes the wrapped key and drops
   * any cached copy. Ciphertext that remains anywhere can no longer be decrypted.
   */
  async shred(subjectId: string): Promise<void> {
    await this.#ledger?.record(subjectId);
    await this.#store.delete(subjectId);
    this.forget(subjectId);
  }

  /** Re-wraps the subject's key under the current master key version. */
  async rewrap(subjectId: string): Promise<void> {
    await this.#assertNotShredded(subjectId);
    const record = await this.#store.get(subjectId);
    if (!record) throw new KeyDestroyedError();
    await this.#store.replace(
      subjectId,
      await this.#wrapper.rewrap(record.wrapped, this.#context(subjectId)),
    );
  }

  /** Zeroes and drops the cached key for one subject. */
  forget(subjectId: string): void {
    const entry = this.#cache.get(subjectId);
    if (entry) entry.key.fill(0);
    this.#cache.delete(subjectId);
    this.#stopTimerIfIdle();
  }

  /** Zeroes and drops every cached key. Call on shutdown. */
  clearCache(): void {
    for (const id of [...this.#cache.keys()]) this.forget(id);
  }

  #context(subjectId: string): KeyContext {
    return { subjectId, purpose: this.#purpose };
  }

  async #assertNotShredded(subjectId: string): Promise<void> {
    if (this.#ledger && (await this.#ledger.isShredded(subjectId))) {
      this.forget(subjectId);
      throw new KeyDestroyedError();
    }
  }

  async #withKey<T>(subjectId: string, create: boolean, use: (key: Uint8Array) => T): Promise<T> {
    // The ledger is checked on every use, so a subject erased elsewhere stops working at once.
    await this.#assertNotShredded(subjectId);
    const { key, cached } = await this.#resolve(subjectId, create);
    try {
      return use(key);
    } finally {
      if (!cached) key.fill(0);
    }
  }

  async #resolve(
    subjectId: string,
    create: boolean,
  ): Promise<{ key: Uint8Array; cached: boolean }> {
    const hit = this.#cache.get(subjectId);
    if (hit) {
      if (hit.expiresAt > this.#now()) return { key: hit.key, cached: true };
      this.forget(subjectId);
    }

    // Concurrent first uses of the same subject share one lookup or creation.
    let pending = this.#inflight.get(subjectId);
    if (!pending) {
      pending = this.#load(subjectId, create).finally(() => this.#inflight.delete(subjectId));
      this.#inflight.set(subjectId, pending);
    }
    const key = await pending;
    if (this.#ttl === 0) return { key, cached: false };
    if (!this.#cache.has(subjectId)) {
      this.#cache.set(subjectId, { key, expiresAt: this.#now() + this.#ttl });
      this.#startTimer();
    }
    return { key, cached: true };
  }

  async #load(subjectId: string, create: boolean): Promise<Uint8Array> {
    const context = this.#context(subjectId);
    const existing = await this.#store.get(subjectId);
    if (existing) return this.#wrapper.unwrap(existing.wrapped, context);
    if (!create) throw new KeyDestroyedError();

    const generated = await this.#wrapper.generateDataKey(context);
    const stored = await this.#store.putIfAbsent(subjectId, {
      wrapped: generated.wrapped,
      keyId: generated.keyId,
    });
    if (stored) return generated.plaintext;

    // Another process created the key first: use theirs and discard ours.
    generated.plaintext.fill(0);
    const winner = await this.#store.get(subjectId);
    if (!winner) throw new KeyDestroyedError();
    return this.#wrapper.unwrap(winner.wrapped, context);
  }

  #startTimer(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => {
        const now = this.#now();
        for (const [id, entry] of this.#cache) if (entry.expiresAt <= now) this.forget(id);
      },
      Math.max(1000, this.#ttl / 2),
    );
    this.#timer.unref();
  }

  #stopTimerIfIdle(): void {
    if (this.#cache.size === 0 && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
