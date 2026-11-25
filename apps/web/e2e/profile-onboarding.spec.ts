/**
 * Onboarding steps 3 and 4 (TASKS M1.7): the privacy walkthrough, then the first profile save.
 * The gateway is mocked; synthetic data only.
 */
import { expect, test } from '@playwright/test';
import { gqlError, mockGraphQL, signedIn } from './support/graphql';

const active = {
  account: { id: 'synthetic-account', status: 'ACTIVE' },
  consents: [],
  currentPolicies: [],
};

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('walkthrough, then a profile with a blurred distance, then the feed', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -26.123456, longitude: 28.045678 });
  const calls = await mockGraphQL(page, {
    OnboardingState: () => active,
    OnboardingProfile: () => gqlError('PROFILE_REQUIRED', 'Create your profile first.'),
    CreateProfile: () => ({
      updateProfile: { id: 'synthetic-account', displayName: 'Lerato', sharesDistance: true },
    }),
  });

  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'How your privacy works' })).toBeFocused();
  await expect(page.getByText('Step 3 of 4')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your health information stays hidden' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You choose who sees it' })).toBeFocused();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your health information stays hidden' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You stay in control' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it, continue' }).click();

  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeFocused();
  await expect(page.getByText('Step 4 of 4')).toBeVisible();

  // Required fields are checked before anything is sent.
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Enter the name you want others to see.')).toBeVisible();
  await expect(page.getByText('Choose what you are looking for.')).toBeVisible();
  expect(calls.some((c) => c.operationName === 'CreateProfile')).toBe(false);

  await page.getByLabel('Your name').fill('  Lerato ');
  await page.getByLabel('Dating').check();
  await page.getByLabel(/About you/).fill('Hiking on Saturdays, jazz on Sundays.');
  await page.getByRole('button', { name: 'Show my approximate distance' }).click();
  await expect(page.getByText('Your approximate distance will be shown.')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await page.waitForURL('**/feed');
  expect(calls.find((c) => c.operationName === 'CreateProfile')?.variables).toEqual({
    input: {
      displayName: 'Lerato',
      intent: 'DATING',
      bio: 'Hiking on Saturdays, jazz on Sundays.',
      // Rounded to 0.01 degrees in the browser: the exact position never leaves the device.
      location: { latitude: -26.12, longitude: 28.05 },
    },
  });
});

test('a member who already has a profile goes straight to the feed', async ({ page }) => {
  await mockGraphQL(page, {
    OnboardingState: () => active,
    OnboardingProfile: () => ({ me: { id: 'synthetic-account' } }),
  });
  await page.goto('/onboarding');
  await page.waitForURL('**/feed');
});

test('location is optional and nothing is sent without it', async ({ page }) => {
  const calls = await mockGraphQL(page, {
    OnboardingState: () => active,
    OnboardingProfile: () => gqlError('PROFILE_REQUIRED', 'Create your profile first.'),
    CreateProfile: () => ({
      updateProfile: { id: 'synthetic-account', displayName: 'Sipho', sharesDistance: false },
    }),
  });
  await page.goto('/onboarding');
  for (let i = 0; i < 2; i += 1)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Got it, continue' }).click();
  await page.getByLabel('Your name').fill('Sipho');
  await page.getByLabel('Friendship').check();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.waitForURL('**/feed');
  expect(calls.find((c) => c.operationName === 'CreateProfile')?.variables).toEqual({
    input: { displayName: 'Sipho', intent: 'FRIENDSHIP' },
  });
});

test('only the onboarding page may ask for location', async ({ request }) => {
  // With a session cookie, so the middleware serves the page instead of redirecting to sign-in.
  const onboarding = await request.get('/onboarding', {
    headers: { cookie: 'chronos_session=synthetic' },
    maxRedirects: 0,
  });
  expect(onboarding.status()).toBe(200);
  expect(onboarding.headers()['permissions-policy']).toContain('geolocation=(self)');
  const signIn = await request.get('/sign-in');
  expect(signIn.headers()['permissions-policy']).toContain('geolocation=()');
});
