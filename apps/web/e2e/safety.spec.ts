/**
 * Web safety controls (ADR-0017, TASKS M1.9): quick exit, idle sign-out and neutral titles.
 * AC: quick exit replaces the history entry. The gateway and Google are mocked.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible } from './support/axe';
import { mockGraphQL, signedIn } from './support/graphql';

const NEUTRAL_SITE = 'https://www.google.com/';

async function stubGoogle(page: Page) {
  await page.route('https://www.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google</title>stub' }),
  );
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await stubGoogle(page);
});

test.describe('quick exit', () => {
  test('leaves for Google, signs out, and Back cannot return to the page', async ({ page }) => {
    const calls = await mockGraphQL(page, { SignOut: () => ({ signOut: true }) });
    await page.goto('/terms');
    await page.goto('/account');
    await expectAccessible(page, 'quick exit button');

    await page.getByRole('button', { name: 'Quick exit' }).click();
    await page.waitForURL(NEUTRAL_SITE);
    await expect.poll(() => calls.some((c) => c.operationName === 'SignOut')).toBe(true);

    // The account page's history entry was replaced: Back goes to the page before it.
    await page.goBack();
    await page.waitForURL('**/terms');
  });

  test('Escape twice leaves; once does nothing', async ({ page }) => {
    await mockGraphQL(page, { SignOut: () => ({ signOut: true }) });
    await page.goto('/account');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/account$/);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForURL(NEUTRAL_SITE);
  });

  test('every other open tab of the app leaves too', async ({ page, context }) => {
    await mockGraphQL(page, { SignOut: () => ({ signOut: true }) });
    const other = await context.newPage();
    await stubGoogle(other);
    await other.goto('/terms');
    await page.goto('/account');
    await page.getByRole('button', { name: 'Quick exit' }).click();
    await other.waitForURL(NEUTRAL_SITE);
  });
});

test.describe('idle sign-out', () => {
  test('warns a minute before, can be extended, then signs out after 15 minutes', async ({
    page,
  }) => {
    await page.clock.install();
    const calls = await mockGraphQL(page, { SignOut: () => ({ signOut: true }) });
    await page.goto('/account');
    // The heading is server-rendered; wait for the timer itself to be running.
    await expect(page.locator('html')).toHaveAttribute('data-idle-timeout', 'on');

    await page.clock.fastForward('13:30');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.clock.fastForward('00:40');
    const dialog = page.getByRole('alertdialog', { name: 'Are you still there?' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stay signed in' })).toBeFocused();
    await expectAccessible(page, 'idle warning');
    // Quick exit stays usable above the warning.
    await expect(page.getByRole('button', { name: 'Quick exit' })).toBeVisible();
    expect(
      await page.getByRole('button', { name: 'Quick exit' }).evaluate((b) => {
        const r = b.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
      }),
    ).toBe(true);

    // Staying resets the clock.
    await page.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(dialog).toHaveCount(0);
    await page.clock.fastForward('14:10');
    await expect(dialog).toBeVisible();
    expect(calls.some((c) => c.operationName === 'SignOut')).toBe(false);

    await page.clock.fastForward('01:05');
    await page.waitForURL('**/sign-in');
    expect(calls.some((c) => c.operationName === 'SignOut')).toBe(true);
  });

  test('activity keeps the member signed in', async ({ page }) => {
    await page.clock.install();
    await page.goto('/account');
    await expect(page.locator('html')).toHaveAttribute('data-idle-timeout', 'on');
    for (let i = 0; i < 4; i += 1) {
      await page.clock.fastForward('10:00');
      await page.mouse.click(5, 5);
    }
    await page.clock.fastForward('00:02');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/account$/);
  });

  test('never runs on public pages', async ({ page }) => {
    await page.clock.install();
    await page.goto('/terms');
    await page.locator('html[data-theme]').waitFor();
    await page.clock.fastForward('20:00');
    await expect(page.locator('html')).not.toHaveAttribute('data-idle-timeout', 'on');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/terms$/);
  });
});

test.describe('neutral titles and addresses', () => {
  /** Nothing in a title, description or address may imply health. */
  const REVEALING =
    /health|hiv|aids|chronic|condition|diagnos|illness|disease|medical|vault|diabet|cancer|epilep/i;

  for (const path of [
    '/sign-in',
    '/terms',
    '/privacy',
    '/onboarding',
    '/account',
    '/account-deleted',
    '/private',
    '/profile',
    '/feed',
    '/matches',
    '/verify',
  ]) {
    test(`${path} has a neutral title and description`, async ({ page }) => {
      await page.goto(path);
      const title = await page.title();
      expect(title).toMatch(/Chronos Place$/);
      expect(title).not.toMatch(REVEALING);
      const description = await page.locator('meta[name="description"]').getAttribute('content');
      expect(description ?? '').not.toMatch(REVEALING);
      expect(new URL(page.url()).pathname).not.toMatch(REVEALING);
    });
  }

  test('the old /health address is gone', async ({ request }) => {
    const res = await request.get('/health', { headers: { cookie: 'chronos_session=synthetic' } });
    expect(res.status()).toBe(404);
  });
});
