import { inspect } from 'node:util';

/**
 * Wraps a secret so it cannot be logged or serialised by accident.
 * `String(secret)`, `JSON.stringify(secret)`, template literals and `util.inspect` all print `[REDACTED]`.
 * Call `reveal()` at the single place the raw value is needed.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return '[REDACTED]';
  }
}
