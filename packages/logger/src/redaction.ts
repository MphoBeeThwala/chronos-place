import {
  ALLOWLIST_BASE_FIELDS,
  normaliseKey,
  REDACT_KEY_EXACT,
  REDACT_KEY_FRAGMENTS,
} from './keys.js';

export const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 1000;

export type LogMode = 'redact' | 'allowlist';

export interface SanitizeOptions {
  mode: LogMode;
  /** Extra keys to redact (redact mode). Cannot weaken the mandatory list. */
  extraRedactKeys?: readonly string[];
  /** Field names that may appear (allowlist mode), in addition to the safe base fields. */
  allowedFields?: readonly string[];
}

interface Matcher {
  mode: LogMode;
  exact: ReadonlySet<string>;
  allowed: ReadonlySet<string>;
}

const PHONE_LIKE = /(?<![\w.-])\+?\d[\d\s().-]{7,}\d(?![\w-])/g;

/** Patterns for values that must never be logged even when the key looks harmless. */
const VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[EMAIL]'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g, '[JWT]'],
  [/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [REDACTED]'],
  // URLs: keep origin and path, drop the query string and fragment.
  [/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1'],
];

/** Removes personal data patterns from free text. Idempotent. */
export function scrubString(input: string): string {
  let out =
    input.length > MAX_STRING_LENGTH ? `${input.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : input;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  // Phone-like numbers: 9+ digits with optional separators. Dates (8 digits) and UUID segments are left alone.
  return out.replace(PHONE_LIKE, (match) =>
    match.replace(/\D/g, '').length >= 9 ? '[NUMBER]' : match,
  );
}

export function isSensitiveKey(key: string, extra: ReadonlySet<string> = new Set()): boolean {
  const k = normaliseKey(key);
  if (k === '') return false;
  if (REDACT_KEY_EXACT.includes(k) || extra.has(k)) return true;
  return REDACT_KEY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

function makeMatcher(options: SanitizeOptions): Matcher {
  return {
    mode: options.mode,
    exact: new Set((options.extraRedactKeys ?? []).map(normaliseKey)),
    allowed: new Set(
      [...ALLOWLIST_BASE_FIELDS, ...(options.allowedFields ?? [])].map(normaliseKey),
    ),
  };
}

function serializeError(
  error: Error,
  matcher: Matcher,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  const out: Record<string, unknown> = {
    errType: error.name,
    ...(typeof code === 'string' || typeof code === 'number' ? { errCode: String(code) } : {}),
  };
  // Messages and stacks can carry personal data; scrub them, and drop them entirely in allow-list mode.
  if (matcher.mode === 'redact') {
    out['errMessage'] = scrubString(error.message);
    if (error.stack) out['stack'] = scrubString(error.stack);
    if (error.cause !== undefined && depth < MAX_DEPTH) {
      out['cause'] = walk(error.cause, matcher, seen, depth + 1);
    }
  }
  return out;
}

function walk(value: unknown, matcher: Matcher, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return scrubString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
    default:
  }

  const obj = value;
  if (seen.has(obj)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return `[binary ${String(value.byteLength)} bytes]`;

  seen.add(obj);
  try {
    if (value instanceof Error) return serializeError(value, matcher, seen, depth);
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => walk(item, matcher, seen, depth + 1));
      return value.length > MAX_ARRAY_ITEMS
        ? [...items, `[${String(value.length - MAX_ARRAY_ITEMS)} more]`]
        : items;
    }
    const entries: Iterable<[string, unknown]> =
      value instanceof Map
        ? (Array.from(value.entries()).map(([k, v]) => [String(k), v]) as [string, unknown][])
        : value instanceof Set
          ? [['values', Array.from(value.values())]]
          : Object.entries(value);
    return walkEntries(entries, matcher, seen, depth);
  } finally {
    seen.delete(obj);
  }
}

function walkEntries(
  entries: Iterable<[string, unknown]>,
  matcher: Matcher,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, val] of entries) {
    if (matcher.mode === 'allowlist') {
      if (!matcher.allowed.has(normaliseKey(key)) || isSensitiveKey(key)) {
        dropped += 1;
        continue;
      }
    } else if (isSensitiveKey(key, matcher.exact)) {
      out[key] = REDACTED;
      continue;
    }
    const clean = walk(val, matcher, seen, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  if (dropped > 0) out['droppedFields'] = dropped;
  return out;
}

/** Returns a sanitised deep copy of `value`. Never throws and never mutates its input. */
export function sanitize(value: unknown, options: SanitizeOptions): unknown {
  try {
    return walk(value, makeMatcher(options), new WeakSet(), 0);
  } catch {
    return REDACTED;
  }
}

/** Sanitises a log object and always returns a plain object. */
export function sanitizeRecord(value: unknown, options: SanitizeOptions): Record<string, unknown> {
  const clean = sanitize(value, options);
  return clean !== null && typeof clean === 'object' && !Array.isArray(clean)
    ? (clean as Record<string, unknown>)
    : clean === undefined || clean === null
      ? {}
      : { value: clean };
}
