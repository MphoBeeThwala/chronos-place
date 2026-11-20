import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface SigningKeySource {
  /** Public keys as JWK JSON, keyed by kid (identity's GetSigningKeys). */
  fetch(): Promise<{ kid: string; jwkJson: string }[]>;
}

/** Refetching on an unknown kid is throttled, so forged kids cannot flood identity. */
export const REFETCH_INTERVAL_MS = 10_000;

/**
 * Identity's public signing keys, cached. Access tokens are verified locally (ADR-0018). A token
 * with an unknown kid triggers at most one refetch per interval, which picks up key rotation.
 */
export class SigningKeyCache {
  readonly #source: SigningKeySource;
  readonly #now: () => number;
  #keys = new Map<string, KeyObject>();
  #lastFetch = Number.NEGATIVE_INFINITY;
  #inflight: Promise<void> | undefined;

  constructor(source: SigningKeySource, now: () => number = Date.now) {
    this.#source = source;
    this.#now = now;
  }

  /** The key for `kid`, refreshing once if it is unknown. */
  async resolve(kid: string): Promise<KeyObject | undefined> {
    const known = this.#keys.get(kid);
    if (known) return known;
    if (this.#now() - this.#lastFetch >= REFETCH_INTERVAL_MS) await this.refresh();
    return this.#keys.get(kid);
  }

  /** Synchronous lookup for the verifier, after resolve() has run. */
  get(kid: string): KeyObject | undefined {
    return this.#keys.get(kid);
  }

  refresh(): Promise<void> {
    this.#inflight ??= (async () => {
      try {
        this.#lastFetch = this.#now();
        const keys = await this.#source.fetch();
        this.#keys = new Map(
          keys.map((k) => [
            k.kid,
            createPublicKey({ key: JSON.parse(k.jwkJson) as JsonWebKey, format: 'jwk' }),
          ]),
        );
      } finally {
        this.#inflight = undefined;
      }
    })();
    return this.#inflight;
  }
}
