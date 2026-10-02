import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  KeyDestroyedError,
  KeyUnwrapError,
  SubjectKeyring,
  type GeneratedKey,
  type KeyContext,
  type KeyWrapper,
} from '../src/index.js';
import {
  InMemoryKeyWrapper,
  InMemoryShredLedger,
  InMemoryWrappedKeyStore,
} from '../src/testing.js';

const MARKER = 'SYNTHETIC-MARKER-7f3a9c';

/** Wraps the in-memory wrapper to count calls and keep references to the plaintext keys it hands out. */
class SpyWrapper implements KeyWrapper {
  readonly inner = new InMemoryKeyWrapper();
  generated = 0;
  unwrapped = 0;
  readonly handedOut: Uint8Array[] = [];

  async generateDataKey(context: KeyContext): Promise<GeneratedKey> {
    this.generated += 1;
    const out = await this.inner.generateDataKey(context);
    this.handedOut.push(out.plaintext);
    return out;
  }

  async unwrap(wrapped: Uint8Array, context: KeyContext): Promise<Uint8Array> {
    this.unwrapped += 1;
    const key = await this.inner.unwrap(wrapped, context);
    this.handedOut.push(key);
    return key;
  }

  rewrap(wrapped: Uint8Array, context: KeyContext): ReturnType<KeyWrapper['rewrap']> {
    return this.inner.rewrap(wrapped, context);
  }
}

function setup(options: { ttl?: number; ledger?: boolean; now?: () => number } = {}) {
  const wrapper = new SpyWrapper();
  const store = new InMemoryWrappedKeyStore();
  const ledger = options.ledger === true ? new InMemoryShredLedger() : undefined;
  const keyring = new SubjectKeyring({
    wrapper,
    store,
    ...(ledger ? { ledger } : {}),
    ...(options.ttl !== undefined ? { cacheTtlMs: options.ttl } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { wrapper, store, ledger, keyring };
}

describe('SubjectKeyring', () => {
  it('encrypts and decrypts per subject, creating the key on first use', async () => {
    const { keyring, store, wrapper } = setup();
    const sealed = await keyring.encrypt('subject-a', 'payload', { conditions: [MARKER] });
    expect(await keyring.decrypt('subject-a', 'payload', sealed)).toEqual({ conditions: [MARKER] });
    expect(wrapper.generated).toBe(1);
    expect((await store.get('subject-a'))?.wrapped.length).toBeGreaterThan(32);
    keyring.clearCache();
  });

  it('gives each subject its own key', async () => {
    const { keyring } = setup();
    const sealedA = await keyring.encrypt('subject-a', 'payload', { v: 1 });
    await keyring.encrypt('subject-b', 'payload', { v: 2 });
    await expect(keyring.decrypt('subject-b', 'payload', sealedA)).rejects.toThrow(DecryptionError);
    keyring.clearCache();
  });

  it('refuses to open one field as another', async () => {
    const { keyring } = setup();
    const sealed = await keyring.encrypt('subject-a', 'payload', { v: 1 });
    await expect(keyring.decrypt('subject-a', 'note', sealed)).rejects.toThrow(DecryptionError);
    keyring.clearCache();
  });

  it('shares one key between concurrent first writes', async () => {
    const { keyring, wrapper } = setup();
    const sealed = await Promise.all(
      Array.from({ length: 20 }, (_, i) => keyring.encrypt('subject-a', 'payload', { i })),
    );
    expect(wrapper.generated).toBe(1);
    for (const [i, s] of sealed.entries())
      expect(await keyring.decrypt('subject-a', 'payload', s)).toEqual({ i });
    keyring.clearCache();
  });

  it('keeps the winner when two processes create the key at the same time', async () => {
    const wrapper = new SpyWrapper();
    const store = new InMemoryWrappedKeyStore();
    const one = new SubjectKeyring({ wrapper, store });
    const two = new SubjectKeyring({ wrapper, store });
    const [a, b] = await Promise.all([
      one.encrypt('subject-a', 'payload', { who: 1 }),
      two.encrypt('subject-a', 'payload', { who: 2 }),
    ]);
    expect(await one.decrypt('subject-a', 'payload', b)).toEqual({ who: 2 });
    expect(await two.decrypt('subject-a', 'payload', a)).toEqual({ who: 1 });
    one.clearCache();
    two.clearCache();
  });

  describe('plaintext key cache', () => {
    it('reuses the key until the TTL passes, then unwraps again', async () => {
      let now = 1_000;
      const { keyring, wrapper } = setup({ now: () => now });
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 1 });
      await keyring.decrypt('subject-a', 'payload', sealed);
      expect(wrapper.unwrapped).toBe(0);
      now += 60_001;
      await keyring.decrypt('subject-a', 'payload', sealed);
      expect(wrapper.unwrapped).toBe(1);
      keyring.clearCache();
    });

    it('zeroes keys on expiry, forget and clearCache', async () => {
      let now = 1_000;
      const { keyring, wrapper } = setup({ now: () => now });
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 1 });
      const first = wrapper.handedOut[0];
      expect(first?.some((b) => b !== 0)).toBe(true);

      now += 60_001;
      await keyring.decrypt('subject-a', 'payload', sealed);
      expect(first?.every((b) => b === 0)).toBe(true);

      const second = wrapper.handedOut.at(-1);
      keyring.forget('subject-a');
      expect(second?.every((b) => b === 0)).toBe(true);

      await keyring.decrypt('subject-a', 'payload', sealed);
      const third = wrapper.handedOut.at(-1);
      keyring.clearCache();
      expect(third?.every((b) => b === 0)).toBe(true);
    });

    it('does not cache at all with a TTL of 0, and zeroes the key straight after use', async () => {
      const { keyring, wrapper } = setup({ ttl: 0 });
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 1 });
      await keyring.decrypt('subject-a', 'payload', sealed);
      expect(wrapper.unwrapped).toBe(1);
      expect(wrapper.handedOut.every((k) => k.every((b) => b === 0))).toBe(true);
    });

    it('rejects a TTL above 60 seconds', () => {
      expect(
        () =>
          new SubjectKeyring({
            wrapper: new InMemoryKeyWrapper(),
            store: new InMemoryWrappedKeyStore(),
            cacheTtlMs: 60_001,
          }),
      ).toThrow();
    });
  });

  describe('crypto-shred', () => {
    it('makes ciphertext unrecoverable once the wrapped key is deleted', async () => {
      const { keyring, store } = setup();
      const sealed = await keyring.encrypt('subject-a', 'payload', { conditions: [MARKER] });
      const copiedCiphertext = {
        ciphertext: Uint8Array.from(sealed.ciphertext),
        nonce: Uint8Array.from(sealed.nonce),
      };

      await keyring.shred('subject-a');

      expect(await store.get('subject-a')).toBeUndefined();
      await expect(keyring.decrypt('subject-a', 'payload', sealed)).rejects.toThrow(
        KeyDestroyedError,
      );
      await expect(keyring.decrypt('subject-a', 'payload', copiedCiphertext)).rejects.toThrow(
        KeyDestroyedError,
      );
    });

    it('drops the cached key at shred time, so cached data stops decrypting immediately', async () => {
      const { keyring, wrapper } = setup();
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 1 });
      expect(await keyring.decrypt('subject-a', 'payload', sealed)).toEqual({ v: 1 });
      await keyring.shred('subject-a');
      expect(wrapper.handedOut.every((k) => k.every((b) => b === 0))).toBe(true);
      await expect(keyring.decrypt('subject-a', 'payload', sealed)).rejects.toThrow(
        KeyDestroyedError,
      );
    });

    it('cannot be undone by encrypting again for a shredded subject when a ledger is present', async () => {
      const { keyring } = setup({ ledger: true });
      await keyring.encrypt('subject-a', 'payload', { v: 1 });
      await keyring.shred('subject-a');
      await expect(keyring.encrypt('subject-a', 'payload', { v: 2 })).rejects.toThrow(
        KeyDestroyedError,
      );
    });

    it('WITHOUT a ledger a restored backup brings erased data back (why ADR-0014 exists)', async () => {
      const { keyring, store } = setup({ ttl: 0 });
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 'recoverable' });
      const backup = store.snapshot();
      await keyring.shred('subject-a');
      store.restore(backup);
      expect(await keyring.decrypt('subject-a', 'payload', sealed)).toEqual({ v: 'recoverable' });
    });

    it('WITH a ledger a restored backup stays unreadable', async () => {
      const { keyring, store } = setup({ ttl: 0, ledger: true });
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 'must stay erased' });
      const backup = store.snapshot();
      await keyring.shred('subject-a');
      store.restore(backup);
      await expect(keyring.decrypt('subject-a', 'payload', sealed)).rejects.toThrow(
        KeyDestroyedError,
      );
      await expect(keyring.rewrap('subject-a')).rejects.toThrow(KeyDestroyedError);
    });

    it('stops a subject erased by another process even when its key is cached here', async () => {
      const wrapper = new SpyWrapper();
      const store = new InMemoryWrappedKeyStore();
      const ledger = new InMemoryShredLedger();
      const here = new SubjectKeyring({ wrapper, store, ledger });
      const elsewhere = new SubjectKeyring({ wrapper, store, ledger });
      const sealed = await here.encrypt('subject-a', 'payload', { v: 1 });
      await elsewhere.shred('subject-a');
      await expect(here.decrypt('subject-a', 'payload', sealed)).rejects.toThrow(KeyDestroyedError);
    });

    it('treats a subject that never had a key like a destroyed one', async () => {
      const { keyring } = setup();
      const other = setup();
      const sealed = await other.keyring.encrypt('subject-x', 'payload', { v: 1 });
      await expect(keyring.decrypt('subject-x', 'payload', sealed)).rejects.toThrow(
        KeyDestroyedError,
      );
      other.keyring.clearCache();
    });
  });

  describe('rewrap', () => {
    it('replaces the wrapped key and keeps old ciphertext readable', async () => {
      const { keyring, store } = setup({ ttl: 0 });
      const sealed = await keyring.encrypt('subject-a', 'payload', { v: 1 });
      const before = (await store.get('subject-a'))?.wrapped;
      await keyring.rewrap('subject-a');
      const after = (await store.get('subject-a'))?.wrapped;
      expect(Buffer.from(after ?? []).equals(Buffer.from(before ?? []))).toBe(false);
      expect(await keyring.decrypt('subject-a', 'payload', sealed)).toEqual({ v: 1 });
    });
  });

  describe('wrapped-key binding', () => {
    it('cannot unwrap a key copied to another subject', async () => {
      const { keyring, store } = setup({ ttl: 0 });
      const sealedA = await keyring.encrypt('subject-a', 'payload', { v: 1 });
      const recordA = await store.get('subject-a');
      if (!recordA) throw new Error('missing record');
      await store.putIfAbsent('subject-b', recordA);
      await expect(keyring.decrypt('subject-b', 'payload', sealedA)).rejects.toThrow(
        KeyUnwrapError,
      );
    });
  });

  describe('privacy', () => {
    it('keeps keys, plaintext and ids out of error messages and serialised errors', async () => {
      const { keyring, wrapper } = setup({ ttl: 0 });
      const sealed = await keyring.encrypt('subject-secret-id', 'payload', { note: MARKER });
      const failures: unknown[] = [];
      await keyring
        .decrypt('subject-secret-id', 'note', sealed)
        .catch((e: unknown) => failures.push(e));
      await keyring.shred('subject-secret-id');
      await keyring
        .decrypt('subject-secret-id', 'payload', sealed)
        .catch((e: unknown) => failures.push(e));
      const keyHex = wrapper.handedOut.map((k) => Buffer.from(k).toString('hex'));
      expect(failures).toHaveLength(2);
      for (const failure of failures) {
        const text = [
          String(failure),
          JSON.stringify(failure),
          (failure as Error).stack ?? '',
        ].join('\n');
        expect(text).not.toContain(MARKER);
        expect(text).not.toContain('subject-secret-id');
        for (const hex of keyHex) expect(text).not.toContain(hex);
      }
    });
  });
});
