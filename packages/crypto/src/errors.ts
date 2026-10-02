/**
 * Crypto errors carry fixed, generic messages. They never include keys, plaintext, ciphertext or
 * subject ids, so they are safe to log and to surface in error handling (CLAUDE.md rule 3).
 */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Authentication failed or the input was malformed. Deliberately gives no reason. */
export class DecryptionError extends CryptoError {
  constructor() {
    super('Decryption failed');
  }
}

/** The subject's key is gone (crypto-shredded or never created). The data cannot be recovered. */
export class KeyDestroyedError extends CryptoError {
  constructor() {
    super('Key is not available');
  }
}

/** The key wrapper (KMS) could not generate, unwrap or re-wrap a key. */
export class KeyUnwrapError extends CryptoError {
  constructor() {
    super('Key operation failed');
  }
}
