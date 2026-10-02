import { REDACT_KEY_FRAGMENTS, REDACTED } from '@chronos/logger';
import type { Finding } from './finding.js';
import { formsOf, type Marker } from './markers.js';

const EXCERPT = 24;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT);
  const raw = text.slice(start, index + length + EXCERPT).replace(/\s+/g, ' ');
  return raw.length > 120 ? raw.slice(0, 120) : raw;
}

/** Looks for every marker, in every encoding, in one piece of captured output. */
export function scanText(sink: string, text: string, markers: readonly Marker[]): Finding[] {
  const lower = text.toLowerCase();
  const findings: Finding[] = [];
  for (const marker of markers) {
    // One finding per marker: the first encoding that matches (raw is checked first).
    for (const form of formsOf(marker)) {
      const haystack = form.caseSensitive ? text : lower;
      const index = haystack.indexOf(form.needle);
      if (index === -1) continue;
      findings.push({
        sink,
        type: 'marker',
        markerKind: marker.kind,
        marker,
        form: form.name,
        detail: `${marker.label} found as ${form.name}`,
        excerpt: excerptAround(text, index, form.needle.length),
      });
      break;
    }
  }
  return findings;
}

/**
 * Generic names such as `status`, `code` or `text` are in the logger's list because they are redacted
 * defensively, but they are ordinary fields in responses. The structural scan uses the fragments
 * (health, contact, credentials, location, ciphertext) plus these short exact names.
 */
const STRUCTURAL_EXACT = new Set([
  'hiv',
  'dob',
  'otp',
  'lat',
  'lng',
  'lon',
  'freetext',
  'note',
  'notes',
  'bio',
  'location',
  'address',
  'dek',
  'jwt',
]);

const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isStructurallySensitive(key: string): boolean {
  const k = normalise(key);
  if (k === '') return false;
  return STRUCTURAL_EXACT.has(k) || REDACT_KEY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

const isRedactedValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === '' ||
  value === REDACTED ||
  value === false ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0);

/**
 * Flags any field whose name says it is sensitive but whose value was not redacted. This catches
 * data the test did not plant: the field name is the evidence.
 */
export function scanStructure(sink: string, value: unknown, trail = '$', depth = 0): Finding[] {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value))
    return value.flatMap((item, i) =>
      scanStructure(sink, item, `${trail}[${String(i)}]`, depth + 1),
    );
  const findings: Finding[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (
      isStructurallySensitive(key) &&
      !isRedactedValue(child) &&
      !(typeof child === 'string' && child.startsWith('[binary '))
    ) {
      findings.push({
        sink,
        type: 'unredacted-field',
        detail: `field "${key}" at ${trail} is sensitive but not redacted`,
      });
      continue;
    }
    findings.push(...scanStructure(sink, child, `${trail}.${key}`, depth + 1));
  }
  return findings;
}

/** Parses JSON, or newline-delimited JSON. Non-JSON text yields nothing (the marker scan still covers it). */
export function parseJsonValues(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    return trimmed.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  }
}
