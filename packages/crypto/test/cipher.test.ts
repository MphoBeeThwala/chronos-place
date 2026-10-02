import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAad,
  CryptoError,
  DecryptionError,
  KEY_LENGTH,
  NONCE_LENGTH,
  open,
  openJson,
  seal,
  sealJson,
  TAG_LENGTH,
} from '../src/index.js';
import { sealWithNonce } from '../src/cipher.js';

const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const key = (): Uint8Array => randomBytes(KEY_LENGTH);
const aad = buildAad('subject-1', 'payload');

describe('AES-256-GCM known answer (GCM spec, test case 16)', () => {
  const K = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
  const IV = hex('cafebabefacedbaddecaf888');
  const P = hex(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
  );
  const A = hex('feedfacedeadbeeffeedfacedeadbeefabaddad2');
  const C =
    '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662';
  const T = '76fc6ece0f4e1768cddf8853bb2d551b';

  it('matches the published ciphertext and tag', () => {
    const sealed = sealWithNonce(K, P, A, IV);
    expect(toHex(sealed.ciphertext)).toBe(C + T);
  });

  it('decrypts the published vector', () => {
    const plaintext = open(K, { ciphertext: hex(C + T), nonce: IV }, A);
    expect(toHex(plaintext)).toBe(toHex(P));
  });
});

describe('round trips', () => {
  it.each([
    ['empty', new Uint8Array(0)],
    ['one byte', Uint8Array.of(7)],
    ['unicode text', new TextEncoder().encode('Thandi — ñ — 你好 — 🌍')],
    ['5 MB random', randomBytes(5 * 1024 * 1024)],
  ])('%s', (_name, plaintext) => {
    const k = key();
    const sealed = seal(k, plaintext, aad);
    expect(sealed.nonce).toHaveLength(NONCE_LENGTH);
    expect(sealed.ciphertext).toHaveLength(plaintext.length + TAG_LENGTH);
    expect(toHex(open(k, sealed, aad))).toBe(toHex(plaintext));
  });

  it('round-trips JSON values', () => {
    const k = key();
    const value = { list: [1, 'two', null], nested: { ok: true }, text: 'synthetic ✓' };
    expect(openJson(k, sealJson(k, value, aad), aad)).toEqual(value);
  });

  it('never repeats a nonce across 10 000 encryptions', () => {
    const k = key();
    const nonces = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) nonces.add(toHex(seal(k, Uint8Array.of(1), aad).nonce));
    expect(nonces.size).toBe(10_000);
  });

  it('does not contain the plaintext in the ciphertext', () => {
    const marker = 'SYNTHETIC-MARKER-7f3a9c';
    const sealed = sealJson(key(), { marker }, aad);
    expect(Buffer.from(sealed.ciphertext).includes(marker)).toBe(false);
  });
});

describe('tampering and misuse always fail with the same generic error', () => {
  const k = key();
  const sealed = seal(k, new TextEncoder().encode('synthetic payload'), aad);
  const copy = () => ({
    ciphertext: Uint8Array.from(sealed.ciphertext),
    nonce: Uint8Array.from(sealed.nonce),
  });

  const flip = (bytes: Uint8Array, index: number): void => {
    bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  };

  it.each([
    [
      'flipped ciphertext bit',
      (s: ReturnType<typeof copy>) => {
        flip(s.ciphertext, 0);
      },
    ],
    [
      'flipped tag bit',
      (s: ReturnType<typeof copy>) => {
        flip(s.ciphertext, s.ciphertext.length - 1);
      },
    ],
    [
      'flipped nonce bit',
      (s: ReturnType<typeof copy>) => {
        flip(s.nonce, 0);
      },
    ],
  ])('%s', (_name, mutate) => {
    const s = copy();
    mutate(s);
    expect(() => open(k, s, aad)).toThrow(DecryptionError);
  });

  it('rejects truncated, extended and wrongly sized input', () => {
    expect(() =>
      open(k, { ...copy(), ciphertext: sealed.ciphertext.subarray(0, 10) }, aad),
    ).toThrow(DecryptionError);
    expect(() =>
      open(k, { ...copy(), ciphertext: sealed.ciphertext.subarray(0, -1) }, aad),
    ).toThrow(DecryptionError);
    expect(() =>
      open(k, { ...copy(), ciphertext: Buffer.concat([sealed.ciphertext, Buffer.from([0])]) }, aad),
    ).toThrow(DecryptionError);
    expect(() => open(k, { ...copy(), nonce: sealed.nonce.subarray(0, 8) }, aad)).toThrow(
      DecryptionError,
    );
  });

  it('rejects the wrong key', () => {
    expect(() => open(key(), copy(), aad)).toThrow(DecryptionError);
  });

  it('rejects a different subject or field (AAD binding)', () => {
    expect(() => open(k, copy(), buildAad('subject-2', 'payload'))).toThrow(DecryptionError);
    expect(() => open(k, copy(), buildAad('subject-1', 'note'))).toThrow(DecryptionError);
  });

  it('keeps AAD parts unambiguous', () => {
    expect(Buffer.from(buildAad('ab', 'c')).equals(Buffer.from(buildAad('a', 'bc')))).toBe(false);
  });

  it('rejects ciphertext that is not valid JSON after authentication', () => {
    const bad = seal(k, new TextEncoder().encode('{not json'), aad);
    expect(() => openJson(k, bad, aad)).toThrow(DecryptionError);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => seal(randomBytes(16), Uint8Array.of(1), aad)).toThrow(CryptoError);
    expect(() => open(randomBytes(31), copy(), aad)).toThrow(CryptoError);
  });

  it('gives no detail about why decryption failed', () => {
    const errors = [
      () => open(key(), copy(), aad),
      () => open(k, { ...copy(), nonce: new Uint8Array(3) }, aad),
      () => open(k, copy(), buildAad('other', 'payload')),
    ].map((fn) => {
      try {
        fn();
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected failure');
    });
    for (const error of errors) {
      expect(error.message).toBe('Decryption failed');
      expect(error.name).toBe('DecryptionError');
    }
  });
});
