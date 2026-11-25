import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRIVACY, TERMS } from '@/legal/policies';
import {
  ageOn,
  grantedAtCurrentVersion,
  isAdult,
  isDraftVersion,
  type OnboardingState,
  onboardingStep,
  parseDateOfBirth,
} from '@/lib/onboarding';

const policies = [
  { type: 'TERMS', version: 'terms-2' },
  { type: 'PRIVACY', version: 'privacy-2' },
  { type: 'MARKETING', version: 'marketing-1-draft' },
];
const state = (
  status: OnboardingState['account']['status'],
  consents: OnboardingState['consents'] = [],
): OnboardingState => ({ account: { id: 'a', status }, consents, currentPolicies: policies });
const grant = (type: string, policyVersion: string, granted = true) => ({
  type,
  policyVersion,
  granted,
});

describe('onboarding steps', () => {
  it('asks for terms and privacy first, then the date of birth', () => {
    expect(onboardingStep(state('PENDING_ONBOARDING'))).toBe('consent');
    expect(onboardingStep(state('PENDING_ONBOARDING', [grant('TERMS', 'terms-2')]))).toBe(
      'consent',
    );
    expect(
      onboardingStep(
        state('PENDING_ONBOARDING', [grant('TERMS', 'terms-2'), grant('PRIVACY', 'privacy-2')]),
      ),
    ).toBe('dateOfBirth');
  });

  it('asks again when a policy has a new version, or the latest entry is a withdrawal', () => {
    const old = state('PENDING_ONBOARDING', [
      grant('TERMS', 'terms-1'),
      grant('PRIVACY', 'privacy-2'),
    ]);
    expect(onboardingStep(old)).toBe('consent');
    const withdrawn = state('PENDING_ONBOARDING', [
      grant('TERMS', 'terms-2'),
      grant('PRIVACY', 'privacy-2'),
      grant('PRIVACY', 'privacy-2', false),
    ]);
    expect(grantedAtCurrentVersion(withdrawn, 'PRIVACY')).toBe(false);
    expect(onboardingStep(withdrawn)).toBe('consent');
  });

  it('never asks for health consent during sign-up', () => {
    const done = state('PENDING_ONBOARDING', [
      grant('TERMS', 'terms-2'),
      grant('PRIVACY', 'privacy-2'),
    ]);
    expect(onboardingStep(done)).toBe('dateOfBirth');
  });

  it('maps the other account states', () => {
    expect(onboardingStep(state('ACTIVE'))).toBe('active');
    expect(onboardingStep(state('INELIGIBLE'))).toBe('ineligible');
    expect(onboardingStep(state('SUSPENDED'))).toBe('closed');
    expect(onboardingStep(state('PENDING_ERASURE'))).toBe('closed');
  });

  it('treats draft policy texts as not ready to offer', () => {
    expect(isDraftVersion('marketing-1-draft')).toBe(true);
    expect(isDraftVersion(undefined)).toBe(true);
    expect(isDraftVersion('terms-2')).toBe(false);
  });
});

describe('date of birth', () => {
  const today = new Date(2026, 10, 25);

  it('accepts a real date and gives the ISO form and age', () => {
    expect(parseDateOfBirth('7', '3', '1990', today)).toEqual({
      ok: true,
      iso: '1990-03-07',
      age: 36,
    });
  });

  it('counts the birthday itself', () => {
    expect(ageOn({ year: 2008, month: 11, day: 25 }, today)).toBe(18);
    expect(ageOn({ year: 2008, month: 11, day: 26 }, today)).toBe(17);
    expect(isAdult(18)).toBe(true);
    expect(isAdult(17)).toBe(false);
  });

  it('catches typing mistakes', () => {
    const error = (d: string, m: string, y: string) => {
      const r = parseDateOfBirth(d, m, y, today);
      return r.ok ? undefined : r.error;
    };
    expect(error('31', '2', '1990')).toMatch(/does not exist/);
    expect(error('29', '2', '2001')).toMatch(/does not exist/);
    expect(parseDateOfBirth('29', '2', '2000', today).ok).toBe(true);
    expect(error('1', '13', '1990')).toMatch(/does not exist/);
    expect(error('a', '1', '1990')).toMatch(/numbers/);
    expect(error('1', '1', '90')).toMatch(/four digits/);
    expect(error('1', '1', '2030')).toMatch(/past/);
    expect(error('1', '1', '1850')).toMatch(/year/);
  });

  it('leaves the under-18 decision to the server, after the member confirms', () => {
    // A 16-year-old's date parses; the confirmation screen warns, and identity decides.
    expect(parseDateOfBirth('1', '1', '2010', today)).toMatchObject({ ok: true, age: 16 });
  });
});

describe('policy pages', () => {
  it('show the versions identity asks members to accept', () => {
    const identity = readFileSync(
      new URL('../../../services/identity/src/consent/policies.ts', import.meta.url),
      'utf8',
    );
    expect(identity).toContain(`terms: '${TERMS.version}'`);
    expect(identity).toContain(`privacy: '${PRIVACY.version}'`);
  });
});
