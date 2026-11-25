/**
 * Every onboarding screen in the dark theme (TASKS M1.7): colours change there, so contrast is
 * checked again. The gateway and storage are mocked; synthetic data only.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible } from './support/axe';
import { gqlError, mockGraphQL, signedIn } from './support/graphql';

test.use({ colorScheme: 'dark' });

const POLICIES = [
  { type: 'TERMS', version: 'terms-2026-11-26' },
  { type: 'PRIVACY', version: 'privacy-2026-11-26' },
];
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('sign-in, in the dark theme', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByLabel('Phone number')).toBeVisible();
  await expectAccessible(page, 'dark: sign-in');
});

test('every onboarding step, in the dark theme', async ({ page }) => {
  await signedIn(page);
  await page.route('http://127.0.0.1:8333/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }),
  );
  let status = 'PENDING_ONBOARDING';
  let consents: { type: string; policyVersion: string; granted: boolean }[] = [];
  await mockGraphQL(page, {
    OnboardingState: () => ({
      account: { id: 'synthetic-account', status },
      consents,
      currentPolicies: POLICIES,
    }),
    RecordConsent: (v) => {
      const input = v['input'] as { type: string; policyVersion: string; granted: boolean };
      consents = [...consents, input];
      return { recordConsent: true };
    },
    SetDateOfBirth: () => {
      status = 'ACTIVE';
      return { setDateOfBirth: { id: 'synthetic-account', status } };
    },
    OnboardingProfile: () => gqlError('PROFILE_REQUIRED', 'Create your profile first.'),
    CreateProfile: () => ({
      updateProfile: { id: 'synthetic-account', displayName: 'Ayanda', sharesDistance: false },
    }),
    MyPhotos: () => ({
      me: {
        id: 'synthetic-account',
        photos: ['PENDING', 'REJECTED'].map((s, i) => ({
          id: `photo-${String(i)}`,
          position: i,
          status: s,
          width: 640,
          height: 640,
          variants: [{ size: 320, url: `http://127.0.0.1:8333/photo-media/${String(i)}.png` }],
        })),
      },
    }),
    CreatePhotoUpload: () => gqlError('RATE_LIMITED', 'Too many uploads. Try again in an hour.'),
  });

  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Before we begin' })).toBeVisible();
  await expectAccessible(page, 'dark: consent');
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByLabel(/I have read the Privacy Policy/).check();
  await page.getByRole('button', { name: 'Agree and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Your date of birth' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectAccessible(page, 'dark: date of birth with an error');
  await page.getByLabel('Day').fill('2');
  await page.getByLabel('Month').fill('9');
  await page.getByLabel('Year').fill('1988');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectAccessible(page, 'dark: confirm date of birth');
  await page.getByRole('button', { name: "Yes, that's right" }).click();

  await expect(page.getByRole('heading', { name: 'How your privacy works' })).toBeVisible();
  await expectAccessible(page, 'dark: walkthrough');
  for (let i = 0; i < 2; i += 1)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Got it, continue' }).click();

  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Enter the name you want others to see.')).toBeVisible();
  await expectAccessible(page, 'dark: profile with errors');
  await page.getByLabel('Your name').fill('Ayanda');
  await page.getByLabel('A long-term relationship').check();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('img', { name: 'Photo 2 of 2' })).toBeVisible();
  await expect(page.getByText(/Not approved/)).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add another photo' }).click();
  await (await chooser).setFiles({ name: 'a.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(/Too many uploads/);
  await expectAccessible(page, 'dark: photos with a rejected photo and an error');
});
