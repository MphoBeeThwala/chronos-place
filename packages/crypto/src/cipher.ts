import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError, DecryptionError } from './errors.js';

export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
/** Bumped if the ciphertext format or AAD layout ever changes. Part of every AAD. */
export const FORMAT_VERSION = 1;

/** Output of encryption. `ciphertext` has the 16-byte GCM tag appended. */
export interface Sealed {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Builds the additional authenticated data that binds a ciphertext to its owner and field.
 * Parts are length-prefixed so ("ab","c") and ("a","bc") can never collide.
 */
export function buildAad(subjectId: string, field: string): Uint8Array {
  const parts = [`chronos-aad-v${String(FORMAT_VERSION)}`, subjectId, field].map((p) =>
    ENCODER.encode(p),
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) throw new CryptoError('Invalid key length');
}

/** Encrypts with an explicit nonce. Internal: exported only so the known-answer test can pin the nonce. */
export function sealWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
): Sealed {
  assertKey(key);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/** AES-256-GCM with a fresh random 96-bit nonce. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Sealed {
  return sealWithNonce(key, plaintext, aad, randomBytes(NONCE_LENGTH));
}

/** Decrypts and authenticates. Any failure throws the same `DecryptionError`. */
export function open(key: Uint8Array, sealed: Sealed, aad: Uint8Array): Uint8Array {
  assertKey(key);
  const { ciphertext, nonce } = sealed;
  if (nonce.length !== NONCE_LENGTH || ciphertext.length < TAG_LENGTH) throw new DecryptionError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LENGTH);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Encrypts a JSON-serialisable value. */
export function sealJson(key: Uint8Array, value: unknown, aad: Uint8Array): Sealed {
  const json = JSON.stringify(value);
  return seal(key, ENCODER.encode(json), aad);
}

/** Decrypts to an unknown value. Callers validate the shape (zod) before use. */
export function openJson(key: Uint8Array, sealed: Sealed, aad: Uint8Array): unknown {
  const plaintext = open(key, sealed, aad);
  try {
    return JSON.parse(DECODER.decode(plaintext)) as unknown;
  } catch {
    throw new DecryptionError();
  }
}
