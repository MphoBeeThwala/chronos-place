/**
 * Content Security Policy with per-request nonces (ADR-0017, TASKS M1.9).
 * AC: an inline script without the nonce is blocked under the real policy.
 */
import { expect, type Page, test } from '@playwright/test';
import { mockGraphQL, signedIn } from './support/graphql';

const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

/** Records every CSP violation the page reports. */
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

test('an inline script without the nonce is blocked; one with it runs', async ({
  page,
  request,
}) => {
  // The policy exactly as the app serves it.
  const real = await request.get('/sign-in');
  const csp = real.headers()['content-security-policy'] ?? '';
  const nonce = nonceOf(csp);
  expect(nonce).toBeTruthy();

  await page.route('**/csp-probe', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'content-security-policy': csp },
      body: `<!doctype html><html><body>
        <script>window.unsafeRan = true;</script>
        <script nonce="${nonce ?? ''}">window.trustedRan = true;</script>
        <script nonce="not-the-nonce">window.wrongNonceRan = true;</script>
        <img src="https://images.example/tracker.png" alt="">
      </body></html>`,
    }),
  );
  const violations = await watchViolations(page);
  await page.goto('/csp-probe');
  const ran = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { unsafe: w['unsafeRan'], trusted: w['trustedRan'], wrong: w['wrongNonceRan'] };
  });
  expect(ran).toEqual({ unsafe: undefined, trusted: true, wrong: undefined });
  await expect
    .poll(violations)
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^script-src/),
        expect.stringMatching(/^img-src https:\/\/images\.example/),
      ]),
    );
});

test('every script on a real page carries that request’s nonce, new each time', async ({
  request,
}) => {
  const nonces = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    const res = await request.get('/terms');
    const nonce = nonceOf(res.headers()['content-security-policy'] ?? '');
    expect(nonce).toBeTruthy();
    nonces.add(nonce ?? '');
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce ?? ''}"`);
  }
  expect(nonces.size).toBe(3);
});

for (const [name, path, signIn] of [
  ['sign-in', '/sign-in', false],
  ['terms', '/terms', false],
  ['onboarding', '/onboarding', true],
  ['your data and account', '/account', true],
] as const) {
  test(`${name} loads with no CSP violations`, async ({ page }) => {
    if (signIn) await signedIn(page);
    await mockGraphQL(page, {
      OnboardingState: () => ({
        account: { id: 'synthetic-account', status: 'PENDING_ONBOARDING' },
        consents: [],
        currentPolicies: [
          { type: 'TERMS', version: 'terms-2026-11-26' },
          { type: 'PRIVACY', version: 'privacy-2026-11-26' },
        ],
      }),
    });
    const violations = await watchViolations(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // The theme script ran, so the inline script with the nonce was allowed.
    await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
    expect(await violations()).toEqual([]);
  });
}

test('the selfie check loads its camera component with no CSP violations', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await context.grantPermissions(['camera']);
  await mockGraphQL(page, {
    Verification: () => ({
      verification: {
        status: 'UNVERIFIED',
        failure: null,
        attemptsRemaining: 5,
        reviewAvailable: false,
      },
    }),
    VerificationConsent: () => ({
      consents: [
        { type: 'BIOMETRIC_VERIFICATION', policyVersion: 'biometric-draft', granted: true },
      ],
      currentPolicies: [{ type: 'BIOMETRIC_VERIFICATION', version: 'biometric-draft' }],
    }),
  });
  const violations = await watchViolations(page);
  await page.goto('/verify');
  await page
    .getByRole('button', { name: /start|take|selfie/i })
    .first()
    .click();
  // The vendor's component, loaded by a trusted chunk ('strict-dynamic'), defines itself.
  await expect
    .poll(() => page.evaluate(() => customElements.get('smart-camera-web') !== undefined))
    .toBe(true);
  await expect(page.locator('smart-camera-web')).toBeAttached();
  await page.waitForTimeout(1500);
  expect(await violations()).toEqual([]);
});
