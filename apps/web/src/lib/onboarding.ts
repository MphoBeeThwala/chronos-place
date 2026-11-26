/**
 * Onboarding steps (TASKS M1.7, ADR-0020): terms and privacy, then date of birth, then the
 * account is active. Worked out from the server's state each time, so a member who leaves
 * halfway comes back to the step they stopped at.
 */

export type AccountStatus =
  'PENDING_ONBOARDING' | 'ACTIVE' | 'INELIGIBLE' | 'SUSPENDED' | 'PENDING_ERASURE';

export interface ConsentEntry {
  type: string;
  policyVersion: string;
  granted: boolean;
}

export interface OnboardingState {
  account: { id: string; status: AccountStatus };
  consents: ConsentEntry[];
  currentPolicies: { type: string; version: string }[];
}

export type OnboardingStep = 'consent' | 'dateOfBirth' | 'active' | 'ineligible' | 'closed';

/** Steps a member sees, in order, with their place in the count shown on screen. */
export const VISIBLE_STEPS = [
  'consent',
  'dateOfBirth',
  'walkthrough',
  'profile',
  'photos',
] as const;
export type VisibleStep = (typeof VISIBLE_STEPS)[number];
export const stepLabel = (step: VisibleStep): string =>
  `Step ${String(VISIBLE_STEPS.indexOf(step) + 1)} of ${String(VISIBLE_STEPS.length)}`;

/**
 * After activation: the privacy walkthrough, then the profile. The walkthrough is not stored;
 * a member who left before saving a profile sees it again, which is harmless.
 */
export function afterActivation(hasProfile: boolean, walkthroughDone: boolean) {
  if (hasProfile) return 'done' as const;
  return walkthroughDone ? ('profile' as const) : ('walkthrough' as const);
}

export const INTENTS = [
  { value: 'LONG_TERM', label: 'A long-term relationship' },
  { value: 'DATING', label: 'Dating' },
  { value: 'FRIENDSHIP', label: 'Friendship' },
  { value: 'OPEN', label: 'Open to seeing where it goes' },
] as const;
export type Intent = (typeof INTENTS)[number]['value'];

/** Text limits from the profile service (ADR-0023 decision h), counted as people see them. */
export const PROFILE_LIMITS = {
  displayName: 30,
  bio: 500,
  gender: 30,
  pronouns: 30,
  areaLabel: 40,
} as const;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const visibleLength = (text: string): number => Array.from(graphemes.segment(text)).length;

/**
 * Blurs a coordinate to the profile service's 0.01-degree grid (about 1 km) in the browser,
 * so the exact position never leaves the device (ADR-0023 decision b).
 */
export const blurCoordinate = (value: number): number => Math.round(value * 100) / 100;

/** Asked during sign-up. Health processing is asked later, before the first health question. */
export const REQUIRED_CONSENTS = ['TERMS', 'PRIVACY'] as const;

/** The latest entry per type decides; history is oldest first. */
export function grantedAtCurrentVersion(state: OnboardingState, type: string): boolean {
  const version = state.currentPolicies.find((p) => p.type === type)?.version;
  const latest = state.consents.filter((c) => c.type === type).at(-1);
  return version !== undefined && latest?.granted === true && latest.policyVersion === version;
}

export function onboardingStep(state: OnboardingState): OnboardingStep {
  switch (state.account.status) {
    case 'ACTIVE':
      return 'active';
    case 'INELIGIBLE':
      return 'ineligible';
    case 'SUSPENDED':
    case 'PENDING_ERASURE':
      return 'closed';
    case 'PENDING_ONBOARDING':
      return REQUIRED_CONSENTS.every((t) => grantedAtCurrentVersion(state, t))
        ? 'dateOfBirth'
        : 'consent';
  }
}

/** A policy text not yet approved by counsel (ADR-0020); it is not offered to members. */
export const isDraftVersion = (version: string | undefined): boolean =>
  version === undefined || version.endsWith('-draft');

export type DateOfBirthResult =
  { ok: true; iso: string; age: number } | { ok: false; error: string };

const MIN_AGE = 18;
const MAX_AGE = 120;

/** Whole years between a date of birth and today. */
export function ageOn(birth: { year: number; month: number; day: number }, today: Date): number {
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const d = today.getDate();
  const birthdayPassed = m > birth.month || (m === birth.month && d >= birth.day);
  return y - birth.year - (birthdayPassed ? 0 : 1);
}

/**
 * Checks the three boxes of the date-of-birth step. The server checks again and decides; this
 * only catches typing mistakes before the member confirms.
 */
export function parseDateOfBirth(
  day: string,
  month: string,
  year: string,
  today: Date = new Date(),
): DateOfBirthResult {
  const digits = /^\d+$/;
  if (![day, month, year].every((v) => digits.test(v.trim()))) {
    return { ok: false, error: 'Enter your date of birth using numbers only.' };
  }
  const [d, m, y] = [day, month, year].map((v) => Number(v.trim())) as [number, number, number];
  if (year.trim().length !== 4) return { ok: false, error: 'Enter the year with four digits.' };
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    m < 1 ||
    m > 12 ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { ok: false, error: 'That date does not exist. Check the day and month.' };
  }
  const age = ageOn({ year: y, month: m, day: d }, today);
  if (age < 0) return { ok: false, error: 'Your date of birth must be in the past.' };
  if (age > MAX_AGE) return { ok: false, error: 'Check the year you were born.' };
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ok: true, iso, age };
}

export const isAdult = (age: number): boolean => age >= MIN_AGE;
