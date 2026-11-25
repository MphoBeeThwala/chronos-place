import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.2 AA for the brand tokens (CLAUDE.md accessibility standard): 4.5:1 for text,
 * 3:1 for focus rings and other non-text indicators. Reads the real tokens.css.
 */
const css = readFileSync(
  new URL('../../../packages/ui/src/tokens/tokens.css', import.meta.url),
  'utf8',
);

function theme(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const light = theme(":root,\n[data-theme='light']");
const dark = { ...light, ...theme("[data-theme='dark']") };

const TEXT_PAIRS: [string, string][] = [
  ['color-text', 'color-bg'],
  ['color-text', 'color-surface'],
  ['color-text', 'color-bg-muted'],
  ['color-text-muted', 'color-bg'],
  ['color-text-muted', 'color-surface'],
  ['color-text-subtle', 'color-surface'],
  ['color-text-on-brand', 'color-primary'],
  ['color-text-on-brand', 'color-primary-hover'],
  ['color-text-on-brand', 'color-primary-active'],
  ['color-text-on-brand', 'color-destructive'],
  ['color-primary', 'color-bg'],
  ['color-primary', 'color-surface'],
  ['color-indicator', 'color-indicator-bg'],
  ['color-success', 'color-success-bg'],
  ['color-warning', 'color-warning-bg'],
  ['color-destructive', 'color-destructive-bg'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast', (_name, tokens) => {
  it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    const [a, b] = [tokens[fg], tokens[bg]];
    expect(a && b, `${fg} or ${bg} missing`).toBeTruthy();
    expect(ratio(a ?? '', b ?? '')).toBeGreaterThanOrEqual(4.5);
  });

  it('focus ring is at least 3:1 against the page', () => {
    expect(ratio(tokens['color-focus'] ?? '', tokens['color-bg'] ?? '')).toBeGreaterThanOrEqual(3);
  });
});
