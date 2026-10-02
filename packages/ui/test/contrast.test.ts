import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  darkColors,
  lightColors,
  resolveScheme,
  themeFor,
  type ColorTokens,
} from '../src/tokens/index';

const TEXT_PAIRS: [keyof ColorTokens, keyof ColorTokens][] = [
  ['text', 'background'],
  ['text', 'surface'],
  ['text', 'surfaceMuted'],
  ['textMuted', 'background'],
  ['textMuted', 'surface'],
  ['textMuted', 'surfaceMuted'],
  ['onAccent', 'accent'],
  ['accentText', 'background'],
  ['accentText', 'surface'],
  ['onDanger', 'danger'],
  ['danger', 'background'],
  ['danger', 'surface'],
  ['success', 'background'],
  ['success', 'surface'],
];

const NON_TEXT_PAIRS: [keyof ColorTokens, keyof ColorTokens][] = [
  ['borderStrong', 'background'],
  ['borderStrong', 'surface'],
  ['focusRing', 'background'],
  ['focusRing', 'surface'],
  ['accent', 'background'],
];

describe.each([
  ['light', lightColors],
  ['dark', darkColors],
])('%s colours meet WCAG 2.2 AA', (_name, colors) => {
  it.each(TEXT_PAIRS)('text: %s on %s is at least 4.5:1', (foreground, background) => {
    expect(contrastRatio(colors[foreground], colors[background])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)('non-text: %s against %s is at least 3:1', (foreground, background) => {
    expect(contrastRatio(colors[foreground], colors[background])).toBeGreaterThanOrEqual(3);
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#FFFFFF', '#777777')).toBeCloseTo(
      contrastRatio('#777777', '#FFFFFF'),
      10,
    );
  });
});

describe('themes', () => {
  it('uses no clinical blue or red-ribbon red as an accent (PRD brand direction)', () => {
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const colors of [lightColors, darkColors]) {
      const accentHue = hue(colors.accent);
      expect(accentHue < 5 || accentHue > 345).toBe(false); // not ribbon red
      expect(accentHue >= 180 && accentHue <= 260).toBe(false); // not blue
    }
  });

  it('resolves the scheme from the preference and the device', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });

  it('gives each scheme its own colours and shares the rest', () => {
    expect(themeFor('light').colors).toBe(lightColors);
    expect(themeFor('dark').colors).toBe(darkColors);
    expect(themeFor('dark').spacing).toBe(themeFor('light').spacing);
  });
});
