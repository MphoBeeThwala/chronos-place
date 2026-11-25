import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA, as CLAUDE.md asks of every screen. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Fails the test if axe finds any WCAG 2.2 AA violation on the page as it is now. `step` names
 * the screen in the failure, so a report says where the problem is.
 */
export async function expectAccessible(page: Page, step: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(TAGS)
    // The Next.js development overlay is not part of the app.
    .exclude('nextjs-portal')
    .analyze();
  const found = violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
  expect(found, `accessibility problems on "${step}"`).toEqual([]);
}
