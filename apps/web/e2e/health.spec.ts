/**
 * Your health profile (TASKS M2.8): conditions, who can see it, filters and who has seen it, with
 * screen protection, and nothing health-related left in browser storage. The gateway is mocked;
 * synthetic data only (CLAUDE.md rule 6).
 */
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './support/axe';
import { gqlError, mockGraphQL, signedIn } from './support/graphql';

const OWN_WORDS = 'Synthetic own words 7f3a';
const NOTE = 'Synthetic note 9c2e';
const TAXONOMY = [
  { code: 'asthma', label: 'Asthma' },
  { code: 'lupus', label: 'Lupus' },
  { code: 'other', label: 'Other (in my own words)' },
];

interface Profile {
  conditions: { code: string; status: string }[];
  freeText: string | null;
  note: string | null;
  visibility: string;
  filterOptIn: boolean;
  version: number;
}

/** A mocked gateway that keeps the member's health profile in memory, like the real one. */
async function healthGateway(page: Page, start: Profile | null = null) {
  let profile = start;
  let filters: string[] = [];
  const calls = await mockGraphQL(page, {
    HealthPage: () => ({
      myHealthProfile: profile,
      conditionTaxonomy: TAXONOMY,
      myHealthFilters: filters,
    }),
    HealthViewers: () => ({
      healthViewers: [
        {
          viewer: { id: 'v1', displayName: 'Thandi' },
          lastViewedAt: '2026-11-03T08:00:00.000Z',
          viewCount: 2,
          hasActiveGrant: true,
        },
        {
          viewer: null,
          lastViewedAt: '2026-11-01T08:00:00.000Z',
          viewCount: 1,
          hasActiveGrant: false,
        },
      ],
    }),
    UpsertHealthProfile: (v) => {
      const input = v['input'] as Omit<Profile, 'visibility' | 'filterOptIn' | 'version'> & {
        expectedVersion: number;
      };
      if (input.expectedVersion !== (profile?.version ?? 0)) {
        return gqlError('CONFLICT', 'Health profile changed elsewhere; reload and try again.');
      }
      profile = {
        conditions: input.conditions,
        freeText: input.freeText,
        note: input.note,
        visibility: profile?.visibility ?? 'HIDDEN',
        filterOptIn: profile?.filterOptIn ?? false,
        version: (profile?.version ?? 0) + 1,
      };
      return { upsertHealthProfile: { version: profile.version } };
    },
    SetHealthVisibility: (v) => {
      if (!profile) throw new Error('no profile');
      profile = {
        ...profile,
        visibility: v['visibility'] as string,
        filterOptIn: (v['filterOptIn'] as boolean | undefined) ?? profile.filterOptIn,
        version: profile.version + 1,
      };
      return { setHealthVisibility: profile };
    },
    SetHealthFilters: (v) => {
      filters = v['conditionCodes'] as string[];
      return { setHealthFilters: filters };
    },
  });
  return { calls, bump: () => profile && (profile = { ...profile, version: profile.version + 1 }) };
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('adds conditions with a status, needs own words for Other, and saves', async ({ page }) => {
  const { calls } = await healthGateway(page);
  await page.goto('/private');
  await expect(page).toHaveTitle(/^Private/);
  await expect(
    page.getByRole('heading', { name: 'Your health profile', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your browser can't stop screenshots", { exact: false }),
  ).toBeVisible();
  await expectAccessible(page, 'health: empty');

  await page.getByLabel('Add a condition').selectOption('asthma');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('group', { name: 'Asthma' }).getByLabel('In remission').check();
  await page.getByLabel('Add a condition').selectOption('other');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // "Other" needs the member's own words before it can be saved.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByLabel('In your own words (optional)').fill(OWN_WORDS);
  await page.getByLabel("Anything else you'd like to add (optional)").fill(NOTE);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  const saved = calls.find((c) => c.operationName === 'UpsertHealthProfile');
  expect(saved?.variables).toEqual({
    input: {
      conditions: [
        { code: 'asthma', status: 'IN_REMISSION' },
        { code: 'other', status: 'LIVING_WITH' },
      ],
      freeText: OWN_WORDS,
      note: NOTE,
      expectedVersion: 0,
    },
  });
  await expectAccessible(page, 'health: saved');
});

test('chooses who can see it, and filters appear only for all verified members', async ({
  page,
}) => {
  const { calls } = await healthGateway(page, {
    conditions: [{ code: 'lupus', status: 'LIVING_WITH' }],
    freeText: null,
    note: null,
    visibility: 'HIDDEN',
    filterOptIn: false,
    version: 1,
  });
  await page.goto('/private');
  await expect(page.getByRole('group', { name: 'Who can see your health profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Find and be found by condition' })).toHaveCount(
    0,
  );

  const everyone = page.getByRole('radio', { name: 'All verified members' });
  await everyone.click();
  await expect(everyone).toBeChecked();
  await expect(page.getByRole('heading', { name: 'Find and be found by condition' })).toBeVisible();
  const optIn = page.getByRole('checkbox', { name: 'Find and be found by condition' });
  await optIn.click();
  await expect(optIn).toBeChecked();
  await page.getByRole('group', { name: 'Conditions to filter by' }).getByLabel('Asthma').check();
  // "Other" cannot be filtered for.
  await expect(
    page
      .getByRole('group', { name: 'Conditions to filter by' })
      .getByLabel('Other (in my own words)'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Save filters' }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible();

  const ops = calls.map((c) => [c.operationName, c.variables]);
  expect(ops).toContainEqual(['SetHealthVisibility', { visibility: 'PROFILE' }]);
  expect(ops).toContainEqual(['SetHealthVisibility', { visibility: 'PROFILE', filterOptIn: true }]);
  expect(ops).toContainEqual(['SetHealthFilters', { conditionCodes: ['asthma'] }]);
  await expectAccessible(page, 'health: settings');
});

test('reloads and says so when another device saved first', async ({ page }) => {
  const gateway = await healthGateway(page, {
    conditions: [],
    freeText: null,
    note: null,
    visibility: 'HIDDEN',
    filterOptIn: false,
    version: 1,
  });
  await page.goto('/private');
  await expect(
    page.getByRole('heading', { name: 'Your health profile', exact: true }),
  ).toBeVisible();
  gateway.bump(); // another device saves
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(
    "This was changed on another device, so we've loaded the latest version. Please check it and save again.",
  );
});

test('lists who has seen it, in the approved words', async ({ page }) => {
  await healthGateway(page);
  await page.goto('/private');
  const list = page.getByRole('region', { name: 'Who has seen your health profile' });
  await expect(list.getByRole('listitem')).toHaveText([
    'Thandi, last viewed 3 Nov, 2 times, still shared',
    "A member you can't see right now, last viewed 1 Nov, 1 time, not shared",
  ]);
});

test('blurs when the tab is hidden and prints a placeholder', async ({ page }) => {
  await healthGateway(page);
  await page.goto('/private');
  const content = page.locator('[data-screen-protect="true"]');
  await expect(content).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(content).toHaveAttribute('data-screen-hidden', 'true');
  expect(await content.evaluate((el) => getComputedStyle(el).filter)).toContain('blur');

  await page.emulateMedia({ media: 'print' });
  await expect(content).toBeHidden();
  await expect(page.locator('.screen-protect-print')).toBeVisible();
});

test('leaves nothing health-related in browser storage, and the page is never cached', async ({
  page,
}) => {
  await healthGateway(page);
  const response = await page.goto('/private');
  expect(response?.headers()['cache-control']).toContain('no-store');

  await page.getByLabel('Add a condition').selectOption('lupus');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('In your own words (optional)').fill(OWN_WORDS);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  const stored = await page.evaluate(async () => {
    const dump = (s: Storage) =>
      Array.from(
        { length: s.length },
        (_, i) => `${s.key(i) ?? ''}=${s.getItem(s.key(i) ?? '') ?? ''}`,
      );
    const databases =
      'databases' in indexedDB ? (await indexedDB.databases()).map((d) => d.name ?? '') : [];
    const caches = 'caches' in window ? await window.caches.keys() : [];
    return {
      local: dump(localStorage),
      session: dump(sessionStorage),
      databases,
      caches,
      cookies: document.cookie,
    };
  });
  expect(stored.databases).toEqual([]);
  expect(stored.caches).toEqual([]);
  const everything = JSON.stringify(stored);
  for (const health of [OWN_WORDS, 'lupus', 'Lupus', 'LIVING_WITH', 'conditions']) {
    expect(everything).not.toContain(health);
  }
});
