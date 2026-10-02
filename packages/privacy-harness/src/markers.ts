import { createHash, randomBytes } from 'node:crypto';

/**
 * What a marker stands for. All values are synthetic (CLAUDE.md rule 6) and unique per run.
 * `health` covers anything that implies a condition: free text, notes and condition codes.
 */
export type MarkerKind = 'health' | 'identity' | 'location' | 'secret';

export interface Marker {
  kind: MarkerKind;
  /** Short description for failure messages, e.g. "condition code". */
  label: string;
  value: string;
}

/**
 * Generates distinct synthetic values from a seed, so a failing run can be reproduced
 * (`PRIVACY_SEED=<seed>`). Without a seed each run gets a random one.
 */
export class MarkerSet {
  readonly seed: string;
  readonly #markers: Marker[] = [];
  #counter = 0;

  constructor(seed?: string) {
    this.seed = seed ?? process.env['PRIVACY_SEED'] ?? randomBytes(6).toString('hex');
  }

  #hex(length: number): string {
    this.#counter += 1;
    return createHash('sha256')
      .update(`${this.seed}:${String(this.#counter)}`)
      .digest('hex')
      .slice(0, length);
  }

  #digits(length: number): string {
    return Array.from(this.#hex(length * 2))
      .map((c) => String(parseInt(c, 16) % 10))
      .join('')
      .slice(0, length);
  }

  #add(kind: MarkerKind, label: string, value: string): string {
    this.#markers.push({ kind, label, value });
    return value;
  }

  /** Free text a member might write about their health. */
  healthText(): string {
    return this.#add('health', 'health free text', `SYNTH-HEALTH-${this.#hex(12)}`);
  }

  /** A condition code, shaped like taxonomy codes (lower case, underscores). */
  conditionCode(): string {
    return this.#add('health', 'condition code', `synth_condition_${this.#hex(8)}`);
  }

  email(): string {
    return this.#add('identity', 'email address', `synth.${this.#hex(10)}@example.test`);
  }

  phone(): string {
    return this.#add('identity', 'phone number', `+27 82 555 ${this.#digits(4)}`);
  }

  /** A coordinate with six decimals, as it would appear in a payload. */
  coordinate(): string {
    return this.#add('location', 'coordinate', `-26.${this.#digits(6)}`);
  }

  secret(): string {
    return this.#add('secret', 'secret value', `synth-secret-${this.#hex(24)}`);
  }

  /** Everything generated so far. */
  all(): readonly Marker[] {
    return this.#markers;
  }
}

/** The ways a marker is checked for. Case-insensitive forms are compared against lower-cased text. */
export interface Form {
  name: string;
  needle: string;
  caseSensitive: boolean;
}

/**
 * Base64 of a value depends on how many bytes precede it (0, 1 or 2 modulo 3). For each alignment,
 * keep only the characters that depend on the value's own bytes, so the needle matches wherever
 * the value is embedded.
 */
const base64Alignments = (value: string): string[] => {
  const out = new Set<string>();
  for (let prefix = 0; prefix < 3; prefix += 1) {
    const encoded = Buffer.from(`${'x'.repeat(prefix)}${value}`)
      .toString('base64')
      .replace(/=+$/, '');
    const start = Math.ceil((prefix * 8) / 6);
    out.add(encoded.slice(start, encoded.length - 3));
  }
  return [...out].filter((needle) => needle.length >= 8);
};

/** All the encodings of a marker that the scan looks for. */
export function formsOf(marker: Marker): Form[] {
  const { value } = marker;
  const forms: Form[] = [
    { name: 'raw', needle: value.toLowerCase(), caseSensitive: false },
    { name: 'hex', needle: Buffer.from(value).toString('hex'), caseSensitive: false },
    {
      name: 'percent-encoded',
      needle: encodeURIComponent(value).toLowerCase(),
      caseSensitive: false,
    },
    {
      name: 'json-escaped',
      needle: JSON.stringify(value).slice(1, -1).toLowerCase(),
      caseSensitive: false,
    },
    {
      name: 'form-encoded',
      needle: encodeURIComponent(value).replace(/%20/g, '+').toLowerCase(),
      caseSensitive: false,
    },
  ];
  for (const needle of base64Alignments(value)) {
    forms.push({ name: 'base64', needle, caseSensitive: true });
    forms.push({
      name: 'base64url',
      needle: needle.replace(/\+/g, '-').replace(/\//g, '_'),
      caseSensitive: true,
    });
  }
  if (marker.kind === 'identity' && value.startsWith('+')) {
    forms.push({ name: 'digits-only', needle: value.replace(/\D/g, ''), caseSensitive: false });
  }
  return forms.filter((f) => f.needle.length >= 6);
}
