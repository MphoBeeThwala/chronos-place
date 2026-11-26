/**
 * Onboarding steps 1 and 2 (TASKS M1.7, ADR-0020): terms and privacy, then date of birth.
 * The gateway is mocked; the full stack runs in the end-to-end suite of PR 4.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible } from './support/axe';
import { gqlError, mockGraphQL, signedIn } from './support/graphql';

const POLICIES = [
  { type: 'TERMS', version: 'terms-2026-11-26' },
  { type: 'PRIVACY', version: 'privacy-2026-11-26' },
  { type: 'HEALTH_PROCESSING', version: 'health-processing-2026-11-20' },
  { type: 'MARKETING', version: 'marketing-2026-11-draft' },
];
const account = (status: string) => ({ id: 'synthetic-account', status });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a new member agrees to terms and privacy, then confirms a date of birth', async ({
  page,
}) => {
  const consents: { type: string; policyVersion: string; granted: boolean }[] = [];
  let status = 'PENDING_ONBOARDING';
  const calls = await mockGraphQL(page, {
    OnboardingState: () => ({ account: account(status), consents, currentPolicies: POLICIES }),
    RecordConsent: ({ input }) => {
      consents.push(input as (typeof consents)[number]);
      return { recordConsent: true };
    },
    SetDateOfBirth: () => {
      status = 'ACTIVE';
      return { setDateOfBirth: account(status) };
    },
    OnboardingProfile: () => gqlError('PROFILE_REQUIRED', 'Create your profile first.'),
  });

  await page.goto('/onboarding');
  const heading = page.getByRole('heading', { name: 'Before we begin' });
  await expect(heading).toBeFocused();
  await expect(page.getByText('Step 1 of 5')).toBeVisible();
  // Health is never asked here, and the draft marketing text is not offered.
  await expect(page.getByText(/updates and community news/)).toHaveCount(0);
  await expectAccessible(page, 'step 1: consent');
  // Downloading or deleting doesn't wait for onboarding (ADR-0025).
  await expect(page.getByRole('link', { name: 'Your data and account' })).toHaveAttribute(
    'href',
    '/account',
  );

  const agree = page.getByRole('button', { name: 'Agree and continue' });
  await expect(agree).toBeDisabled();
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await expect(agree).toBeDisabled();
  await page.getByLabel(/I have read the Privacy Policy/).check();
  await agree.click();

  await expect(page.getByRole('heading', { name: 'Your date of birth' })).toBeFocused();
  expect(consents.map((c) => [c.type, c.policyVersion, c.granted])).toEqual([
    ['TERMS', 'terms-2026-11-26', true],
    ['PRIVACY', 'privacy-2026-11-26', true],
  ]);

  // A date that does not exist is caught before anything is sent.
  await page.getByLabel('Day').fill('31');
  await page.getByLabel('Month').fill('2');
  await page.getByLabel('Year').fill('1990');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/That date does not exist/)).toBeVisible();
  await expect(page.getByLabel('Day')).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page, 'step 2: date of birth with an error');

  await page.getByLabel('Day').fill('7');
  await page.getByLabel('Month').fill('3');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('7 March 1990')).toBeVisible();
  await expect(page.getByText(/cannot be changed later/)).toBeVisible();
  await expectAccessible(page, 'step 2: confirm date of birth');
  expect(calls.some((c) => c.operationName === 'SetDateOfBirth')).toBe(false);
  await page.getByRole('button', { name: "Yes, that's right" }).click();

  await expect(page.getByRole('heading', { name: 'How your privacy works' })).toBeFocused();
  expect(calls.find((c) => c.operationName === 'SetDateOfBirth')?.variables).toEqual({
    dateOfBirth: '1990-03-07',
  });
});

test('a member who left after step 1 comes back to the date of birth', async ({ page }) => {
  await mockGraphQL(page, {
    OnboardingState: () => ({
      account: account('PENDING_ONBOARDING'),
      consents: [
        { type: 'TERMS', policyVersion: 'terms-2026-11-26', granted: true },
        { type: 'PRIVACY', policyVersion: 'privacy-2026-11-26', granted: true },
      ],
      currentPolicies: POLICIES,
    }),
  });
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Your date of birth' })).toBeVisible();
  await expect(page.getByText('Step 2 of 5')).toBeVisible();
});

test('under 18, the account is closed and the member is told plainly', async ({ page }) => {
  await mockGraphQL(page, {
    OnboardingState: () => ({
      account: account('PENDING_ONBOARDING'),
      consents: [
        { type: 'TERMS', policyVersion: 'terms-2026-11-26', granted: true },
        { type: 'PRIVACY', policyVersion: 'privacy-2026-11-26', granted: true },
      ],
      currentPolicies: POLICIES,
    }),
    SetDateOfBirth: () => ({ setDateOfBirth: account('INELIGIBLE') }),
  });
  await page.goto('/onboarding');
  await page.getByLabel('Day').fill('1');
  await page.getByLabel('Month').fill('1');
  await page.getByLabel('Year').fill('2012');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: "Yes, that's right" }).click();
  await expect(page.getByRole('heading', { name: 'Chronos Place is for adults' })).toBeFocused();
  await expect(page.getByText(/did not keep your date of birth/)).toBeVisible();
  await expectAccessible(page, 'under 18');
});

test('the policy pages open without signing in', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  for (const [path, title] of [
    ['/terms', 'Terms of Service'],
    ['/privacy', 'Privacy Policy'],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  }
});
