/**
 * Onboarding end to end against the real services (TASKS M1.7): sign-in with a code delivered to
 * Mailpit, consent, date of birth, the privacy walkthrough, the first profile and a real photo
 * upload to local storage, with an accessibility check on every screen.
 *
 * Needs the local stack and the gateway, identity and profile services running; see
 * `pnpm test:e2e:stack`. Left out of `pnpm test:e2e` (playwright.config.ts). Synthetic data only.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible } from '../support/axe';
import { solidPng } from '../support/png';

/** Local Mailpit, where identity delivers codes in development (ADR-0006). */
const MAILPIT = 'http://127.0.0.1:8025';

/**
 * A synthetic South African mobile number. The local "SMS" only shows the last two digits, so
 * the first of them is the worker's index: runs in parallel never read each other's codes.
 */
function syntheticNumber(worker: number) {
  const middle = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
  return `082${middle}${String(worker % 10)}${String(Math.floor(Math.random() * 10))}`;
}

/** The code from the newest local "SMS" to this number (Mailpit stands in for the provider). */
async function codeFor(page: Page, number: string, after: number): Promise<string> {
  const subject = `SMS to ••${number.slice(-2)}`;
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${MAILPIT}/api/v1/messages?limit=50`);
        const { messages } = (await res.json()) as {
          messages: { Created: string; Subject: string; Snippet: string }[];
        };
        // Newest first; the exact subject, sent after this sign-in started.
        const fresh = messages.find(
          (m) => m.Subject === subject && Date.parse(m.Created) >= after - 1000,
        );
        code = /\b(\d{6})\b/.exec(fresh?.Snippet ?? '')?.[1];
        return code;
      },
      { message: 'the one-time code reaches Mailpit', timeout: 15_000 },
    )
    .toBeTruthy();
  return code ?? '';
}

test('a new member signs up and onboards, accessibly, against the real services', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const number = syntheticNumber(testInfo.parallelIndex);

  await page.goto('/sign-in');
  await expectAccessible(page, 'sign-in: phone number');
  const sentAt = Date.now();
  await page.getByLabel('Phone number').fill(number);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('One-time code')).toBeVisible();
  await expectAccessible(page, 'sign-in: code');
  await page.getByLabel('One-time code').fill(await codeFor(page, number, sentAt));
  await page.getByRole('button', { name: 'Verify' }).click();

  // Step 1: consent.
  await expect(page.getByRole('heading', { name: 'Before we begin' })).toBeVisible();
  await expectAccessible(page, 'step 1: consent');
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByLabel(/I have read the Privacy Policy/).check();
  await page.getByRole('button', { name: 'Agree and continue' }).click();

  // Step 2: date of birth.
  await expect(page.getByRole('heading', { name: 'Your date of birth' })).toBeVisible();
  await expectAccessible(page, 'step 2: date of birth');
  await page.getByLabel('Day').fill('14');
  await page.getByLabel('Month').fill('6');
  await page.getByLabel('Year').fill('1991');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: "Yes, that's right" })).toBeVisible();
  await expectAccessible(page, 'step 2: confirm date of birth');
  await page.getByRole('button', { name: "Yes, that's right" }).click();

  // Step 3: the privacy walkthrough, before any health question.
  await expect(page.getByRole('heading', { name: 'How your privacy works' })).toBeVisible();
  for (let card = 1; card <= 3; card += 1) {
    await expectAccessible(page, `step 3: walkthrough card ${String(card)}`);
    if (card < 3) await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Got it, continue' }).click();

  // Step 4: profile, including its error state.
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expectAccessible(page, 'step 4: profile');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Enter the name you want others to see.')).toBeVisible();
  await expectAccessible(page, 'step 4: profile with errors');
  await page.getByLabel('Your name').fill('Thandiwe');
  await page.getByLabel('Friendship').check();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 5: a real photo, uploaded straight to local storage and processed by the profile service.
  await expect(page.getByRole('heading', { name: 'Your photos' })).toBeVisible();
  await expectAccessible(page, 'step 5: photos, empty');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a photo' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: solidPng(400, [184, 67, 79]),
  });
  const photo = page.getByRole('img', { name: 'Photo 1 of 1' });
  await expect(photo).toBeVisible({ timeout: 20_000 });
  // Locally every photo is approved at once (AutoApproveModerator); review arrives with M5.
  await expect(page.getByText('Waiting for review')).toHaveCount(0);
  // The processed photo really loads from storage: the CSP and storage CORS both allow it.
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)))
    .toBeGreaterThan(0);
  await expectAccessible(page, 'step 5: photos, one added');

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/feed');

  // Coming back skips onboarding: the account and profile were really saved.
  await page.goto('/onboarding');
  await page.waitForURL('**/feed');
});
