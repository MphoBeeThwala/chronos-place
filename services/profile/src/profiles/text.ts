import { DomainError } from '@chronos/service-kit';
import type { PreferencesRecord } from './profile-store.js';

/** Approved limits (ADR-0023, decision h). */
export const LIMITS = {
  displayName: 30,
  bio: 500,
  gender: 30,
  pronouns: 30,
  areaLabel: 40,
  promptAnswer: 300,
  prompts: 3,
  interests: 5,
  genderPreferences: 10,
} as const;

export const AGE_FLOOR = 18;
export const AGE_CEILING = 99;
export const DISTANCE_MIN_KM = 1;
export const DISTANCE_MAX_KM = 300;
/** For a new profile: every age from 18, 50 km, every intent, everyone. */
export const DEFAULT_PREFERENCES: Readonly<PreferencesRecord> = {
  ageMin: AGE_FLOOR,
  ageMax: AGE_CEILING,
  maxDistanceKm: 50,
  intents: [],
  genders: [],
};

/** Fixed messages: never echo what the member typed (CLAUDE.md, errors). */
export const MESSAGES = {
  displayName: `Enter a display name of up to ${String(LIMITS.displayName)} characters.`,
  tooLong: 'That text is too long.',
  prompts: `Choose up to ${String(LIMITS.prompts)} different prompts from the list.`,
  interests: `Choose up to ${String(LIMITS.interests)} interests from the list.`,
  ages: `Ages must be between ${String(AGE_FLOOR)} and ${String(AGE_CEILING)}, lowest first.`,
  distance: `Distance must be between ${String(DISTANCE_MIN_KM)} and ${String(DISTANCE_MAX_KM)} km.`,
  needsProfile: 'Create your profile first.',
  tooMany: 'Too many profiles in one request.',
  needsBasics: 'Add a display name and what you are looking for to create your profile.',
} as const;

// C0 and C1 control characters, apart from line breaks in multi-line text.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
// Bidirectional overrides can make text read differently from what it says.
const BIDI = /[‪-‮⁦-⁩]/g;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Characters as a person counts them: an emoji with skin tone or a flag is one. */
export const length = (text: string): number => Array.from(graphemes.segment(text)).length;

/**
 * Normalises member text: NFC, no control or direction-override characters, trimmed. Single-line
 * fields also lose line breaks and collapse runs of spaces. Returns null for an empty result.
 */
export function cleanText(
  value: string,
  max: number,
  options: { multiline?: boolean } = {},
): string | null {
  let text = value.normalize('NFC').replace(BIDI, '');
  text = options.multiline
    ? text
        .replace(CONTROL, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
    : text
        .replace(/[\r\n\t]+/g, ' ')
        .replace(CONTROL, '')
        .replace(/ {2,}/g, ' ');
  text = text.trim();
  if (length(text) > max) throw new DomainError('invalid_argument', MESSAGES.tooLong);
  return text === '' ? null : text;
}
