import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { PolicyPage } from '@/components/legal/PolicyPage';
import { PRIVACY, TERMS } from '@/legal/policies';
import type { Block } from '@/legal/policy-blocks';

/** All the words of a policy, for checking what members will read. */
const words = (blocks: Block[]): string =>
  blocks
    .flatMap((b) => {
      switch (b.t) {
        case 'h2':
        case 'p':
          return [b.c];
        case 'ul':
        case 'ol':
          return b.items;
        case 'table':
          return [...b.head, ...b.rows.flat()];
      }
    })
    .flat()
    .map((s) => s.v)
    .join('')
    .replace(/\s+/g, ' ');

describe('published policies (approved 2026-11-26)', () => {
  for (const policy of [TERMS, PRIVACY]) {
    it(`${policy.title} has no placeholders or review notes left`, () => {
      const text = words(policy.blocks);
      expect(text).not.toMatch(/\[[A-Z][A-Z ]+\]/); // [LEGAL ENTITY] and the like
      expect(text).not.toMatch(/Counsel:|draft|Placeholder/i);
      expect(text).toContain('Ahava on 88 (Pty) Ltd');
      expect(text).toContain('legal@ahavaon88.co.za');
      expect(policy.version).toMatch(/-2026-11-26$/);
    });
  }

  it('names the registration number and Information Officer as approved', () => {
    expect(words(TERMS.blocks)).toContain('2025/794578/07');
    expect(words(PRIVACY.blocks)).toContain('Information Officer: Mr BM Thwala');
  });

  it('renders accessibly: one h1, section headings, scoped table headers, safe links', () => {
    const html = renderToStaticMarkup(createElement(PolicyPage, { policy: PRIVACY }));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(
      '<h2 class="mt-8 text-xl font-semibold">3. Your health information</h2>',
    );
    expect(html).toContain('<th scope="col"');
    expect(html).toContain('<th scope="row"');
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toContain('(opens in a new tab)');
    expect(html).not.toContain('**');
  });
});
