/**
 * Onboarding step 5 (TASKS M1.7, ADR-0024): optional photos. The gateway and storage are both
 * mocked; the "photos" are a synthetic 1x1 image.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible } from './support/axe';
import { gqlError, mockGraphQL, signedIn } from './support/graphql';

const STORAGE = 'http://127.0.0.1:8333';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const active = {
  account: { id: 'synthetic-account', status: 'ACTIVE' },
  consents: [],
  currentPolicies: [],
};
const photo = (id: string, position: number, status = 'PENDING') => ({
  id,
  position,
  status,
  width: 640,
  height: 640,
  variants: [
    { size: 320, url: `${STORAGE}/photo-media/${id}-320.png` },
    { size: 640, url: `${STORAGE}/photo-media/${id}-640.png` },
  ],
});

/** Storage: serves the synthetic image and records the uploads it receives. */
async function mockStorage(page: Page) {
  const puts: { url: string; contentType: string | undefined }[] = [];
  await page.route(`${STORAGE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      puts.push({ url: req.url(), contentType: req.headers()['content-type'] });
      await route.fulfill({ status: 200, body: '' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });
  return puts;
}

/** Past the walkthrough and first profile save, to step 5. */
async function reachPhotos(page: Page) {
  await page.goto('/onboarding');
  for (let i = 0; i < 2; i += 1)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Got it, continue' }).click();
  await page.getByLabel('Your name').fill('Naledi');
  await page.getByLabel('Dating').check();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your photos' })).toBeFocused();
}

async function choose(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Add (a|another) photo/ }).click();
  await (await chooser).setFiles(file);
}

const base = {
  OnboardingState: () => active,
  OnboardingProfile: () => gqlError('PROFILE_REQUIRED', 'Create your profile first.'),
  CreateProfile: () => ({
    updateProfile: { id: 'synthetic-account', displayName: 'Naledi', sharesDistance: false },
  }),
};

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('upload goes straight to storage, waits for review, can be reordered and deleted', async ({
  page,
}) => {
  const puts = await mockStorage(page);
  let n = 0;
  let photos: ReturnType<typeof photo>[] = [];
  const calls = await mockGraphQL(page, {
    ...base,
    MyPhotos: () => ({ me: { id: 'synthetic-account', photos } }),
    CreatePhotoUpload: () => {
      n += 1;
      return {
        createPhotoUpload: {
          uploadId: `upload-${String(n)}`,
          uploadUrl: `${STORAGE}/photo-uploads/upload-${String(n)}?X-Amz-Signature=synthetic`,
          expiresAt: '2026-11-26T12:15:00Z',
        },
      };
    },
    CompletePhotoUpload: (v) => {
      const p = photo(`photo-${String(v['uploadId']).slice(-1)}`, photos.length);
      photos = [...photos, p];
      return { completePhotoUpload: p };
    },
    ReorderPhotos: (v) => {
      const ids = v['photoIds'] as string[];
      photos = ids.flatMap((id, i) => {
        const found = photos.find((p) => p.id === id);
        return found ? [{ ...found, position: i }] : [];
      });
      return { reorderPhotos: photos };
    },
    DeletePhoto: (v) => {
      photos = photos.filter((p) => p.id !== v['photoId']).map((p, i) => ({ ...p, position: i }));
      return { deletePhoto: photos };
    },
  });

  await reachPhotos(page);
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();

  await choose(page, { name: 'one.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(page.getByRole('img', { name: 'Photo 1 of 1' })).toBeVisible();
  await expect(page.getByText('Waiting for review')).toBeVisible();
  expect(puts).toEqual([
    {
      url: `${STORAGE}/photo-uploads/upload-1?X-Amz-Signature=synthetic`,
      contentType: 'image/png',
    },
  ]);
  expect(calls.find((c) => c.operationName === 'CreatePhotoUpload')?.variables).toEqual({
    contentType: 'image/png',
    byteLength: PIXEL.length,
  });

  await choose(page, { name: 'two.webp', mimeType: 'image/webp', buffer: PIXEL });
  await expect(page.getByRole('img', { name: 'Photo 2 of 2' })).toBeVisible();
  await expect(page.getByText('2 of 6 added.')).toBeVisible();
  await expectAccessible(page, 'step 5: two photos waiting for review');

  // Reorder with buttons: the first can't move earlier, the last can't move later.
  await expect(page.getByRole('button', { name: 'Move photo 1 earlier' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move photo 2 later' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move photo 2 earlier' }).click();
  await expect
    .poll(() => calls.find((c) => c.operationName === 'ReorderPhotos')?.variables)
    .toEqual({ photoIds: ['photo-2', 'photo-1'] });
  await expect(page.getByRole('img', { name: 'Photo 1 of 2' })).toHaveAttribute(
    'src',
    /photo-2-320/,
  );

  // Delete asks first.
  await page.getByRole('button', { name: 'Delete photo 2' }).click();
  await expectAccessible(page, 'step 5: confirm delete');
  await page.getByRole('button', { name: 'Keep' }).click();
  expect(calls.some((c) => c.operationName === 'DeletePhoto')).toBe(false);
  await page.getByRole('button', { name: 'Delete photo 2' }).click();
  await page.getByRole('button', { name: 'Delete photo 2' }).click();
  await expect(page.getByRole('img', { name: 'Photo 1 of 1' })).toBeVisible();
  expect(calls.find((c) => c.operationName === 'DeletePhoto')?.variables).toEqual({
    photoId: 'photo-1',
  });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/feed');
});

test('wrong types and large files are turned away before anything is sent', async ({ page }) => {
  await mockStorage(page);
  const calls = await mockGraphQL(page, {
    ...base,
    MyPhotos: () => ({ me: { id: 'synthetic-account', photos: [] } }),
  });
  await reachPhotos(page);
  await choose(page, { name: 'move.gif', mimeType: 'image/gif', buffer: PIXEL });
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(
    'Choose a JPEG, PNG or WebP photo.',
  );
  await choose(page, {
    name: 'huge.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(
    'That photo is over 10 MB. Choose a smaller one.',
  );
  await expectAccessible(page, 'step 5: file turned away');
  expect(calls.some((c) => c.operationName === 'CreatePhotoUpload')).toBe(false);
});

test('a failed upload and the hourly limit are explained', async ({ page }) => {
  await page.route(`${STORAGE}/**`, (route) => route.fulfill({ status: 403, body: '' }));
  let tries = 0;
  await mockGraphQL(page, {
    ...base,
    MyPhotos: () => ({ me: { id: 'synthetic-account', photos: [] } }),
    CreatePhotoUpload: () => {
      tries += 1;
      if (tries > 1) return gqlError('RATE_LIMITED', 'Too many uploads. Try again in an hour.');
      return {
        createPhotoUpload: {
          uploadId: 'upload-1',
          uploadUrl: `${STORAGE}/photo-uploads/upload-1`,
          expiresAt: '2026-11-26T12:15:00Z',
        },
      };
    },
  });
  await reachPhotos(page);
  await choose(page, { name: 'one.jpg', mimeType: 'image/jpeg', buffer: PIXEL });
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(/did not finish/);
  await choose(page, { name: 'one.jpg', mimeType: 'image/jpeg', buffer: PIXEL });
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(
    'Too many uploads. Try again in an hour.',
  );
});

test('with six photos, no more can be added', async ({ page }) => {
  await mockStorage(page);
  await mockGraphQL(page, {
    ...base,
    MyPhotos: () => ({
      me: {
        id: 'synthetic-account',
        photos: [0, 1, 2, 3, 4, 5].map((i) => photo(`photo-${String(i)}`, i, 'APPROVED')),
      },
    }),
  });
  await reachPhotos(page);
  await expect(page.getByRole('img', { name: 'Photo 6 of 6' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Add (a|another) photo/ })).toHaveCount(0);
  await expectAccessible(page, 'step 5: six photos');
  await expect(page.getByText('Waiting for review')).toHaveCount(0);
});

test('storage is allowed by the content security policy', async ({ request }) => {
  const res = await request.get('/onboarding', {
    headers: { cookie: 'chronos_session=synthetic' },
    maxRedirects: 0,
  });
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(new RegExp(`connect-src 'self' ${STORAGE.replace(/\./g, '\\.')}`));
  expect(csp).toContain(STORAGE);
});
