/**
 * Your data and account (TASKS M1.8, ADR-0025): download everything, or delete the account with a
 * fresh code. The gateway is mocked; synthetic data only.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { expectAccessible } from './support/axe';
import { gqlError, mockGraphQL, signedIn } from './support/graphql';

const EXPORT_JSON = JSON.stringify({ format: 'chronos-export/1', account: { id: 'synthetic' } });
const CHALLENGE = '11111111-1111-4111-8111-111111111111';

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('downloads everything as one dated JSON file', async ({ page }) => {
  await mockGraphQL(page, {
    MyDataExport: () => ({
      myDataExport: {
        format: 'chronos-export/1',
        generatedAt: '2026-11-26T08:00:00.000Z',
        json: EXPORT_JSON,
      },
    }),
  });
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Your data and account' })).toBeVisible();
  await expectAccessible(page, 'account: start');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const file = await download;
  // Only the date in the name: never the member's name or number.
  expect(file.suggestedFilename()).toBe('chronos-place-my-data-2026-11-26.json');
  expect(await readFile(await file.path(), 'utf8')).toBe(EXPORT_JSON);
  await expect(page.getByText(/Your file has downloaded/)).toBeVisible();
});

test('explains the hourly download limit', async ({ page }) => {
  await mockGraphQL(page, {
    MyDataExport: () =>
      gqlError(
        'RATE_LIMITED',
        'You have downloaded your data a few times recently. Try again later.',
      ),
  });
  await page.goto('/account');
  await page.getByRole('button', { name: 'Download my data' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(/a few times recently/);
  await expectAccessible(page, 'account: download refused');
});

test('deletes the account only with the texted code, and can be cancelled', async ({ page }) => {
  let attempts = 0;
  const calls = await mockGraphQL(page, {
    RequestAccountDeletionCode: () => ({
      requestAccountDeletionCode: {
        challengeId: CHALLENGE,
        expiresAt: '2026-11-26T08:05:00.000Z',
        retryAfterSeconds: 60,
      },
    }),
    DeleteAccount: (v) => {
      attempts += 1;
      if (v['code'] !== '123456') return gqlError('BAD_USER_INPUT', 'Code not accepted.');
      return { deleteAccount: { id: 'synthetic-account', status: 'PENDING_ERASURE' } };
    },
  });
  await page.goto('/account');
  await expect(page.getByText('It cannot be undone.', { exact: false })).toBeVisible();

  // Changing your mind is one click away at every step.
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expectAccessible(page, 'account: confirm deletion');
  await page.getByRole('button', { name: 'Keep my account' }).click();
  expect(calls.some((c) => c.operationName === 'RequestAccountDeletionCode')).toBe(false);

  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await page.getByRole('button', { name: 'Send the code' }).click();
  const field = page.getByLabel('Code from the text message');
  await expect(field).toBeFocused();
  // Nothing to submit until all six digits are in.
  await field.fill('12');
  await expect(page.getByRole('button', { name: 'Delete my account permanently' })).toBeDisabled();
  await expectAccessible(page, 'account: enter code');

  await field.fill('000000');
  await page.getByRole('button', { name: 'Delete my account permanently' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText('Code not accepted.');
  await expectAccessible(page, 'account: wrong code');

  await field.fill('123456');
  await page.getByRole('button', { name: 'Delete my account permanently' }).click();
  await page.waitForURL('**/account-deleted');
  expect(attempts).toBe(2);
  expect(
    calls.find((c) => c.operationName === 'DeleteAccount' && c.variables['code'] === '123456')
      ?.variables,
  ).toEqual({
    challengeId: CHALLENGE,
    code: '123456',
  });
});

test('the goodbye page works signed out, and is accessible', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/account-deleted');
  await expect(page.getByRole('heading', { name: 'Your account is being deleted' })).toBeVisible();
  await expect(page.getByText(/within 30 days/)).toBeVisible();
  await expectAccessible(page, 'account deleted');
});

test('signed out, the account page asks you to sign in', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/account');
  await page.waitForURL('**/sign-in**');
});

test.describe('in the dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the account page is accessible', async ({ page }) => {
    await mockGraphQL(page, {
      RequestAccountDeletionCode: () => ({
        requestAccountDeletionCode: {
          challengeId: CHALLENGE,
          expiresAt: '2026-11-26T08:05:00.000Z',
          retryAfterSeconds: 60,
        },
      }),
    });
    await page.goto('/account');
    await expectAccessible(page, 'dark: account');
    await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await page.getByRole('button', { name: 'Send the code' }).click();
    await expect(page.getByLabel('Code from the text message')).toBeFocused();
    await expectAccessible(page, 'dark: account, enter code');
  });
});
