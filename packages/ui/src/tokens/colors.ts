/**
 * Semantic colour tokens. The palette is provisional (warm terracotta, no clinical blues or red
 * ribbons, per the PRD brand direction) until the Figma design system supplies final values. Change
 * colours here only: every component reads these names, and `contrast.test.ts` fails if a pairing
 * drops below WCAG 2.2 AA.
 */
export interface ColorTokens {
  background: string;
  surface: string;
  surfaceMuted: string;
  /** Body text. */
  text: string;
  /** Secondary text. Still meets 4.5:1. */
  textMuted: string;
  /** Fill for primary actions. */
  accent: string;
  /** Text on `accent`. */
  onAccent: string;
  /** Accent used as text or an icon on `background` or `surface`. */
  accentText: string;
  /** Border of interactive controls: meets 3:1 against its surface. */
  borderStrong: string;
  /** Decorative dividers. Not for controls. */
  border: string;
  danger: string;
  onDanger: string;
  success: string;
  focusRing: string;
  overlay: string;
}

export const lightColors: ColorTokens = {
  background: '#FFF8F2',
  surface: '#FFFFFF',
  surfaceMuted: '#F6EBE1',
  text: '#2A1D19',
  textMuted: '#665349',
  accent: '#A23B28',
  onAccent: '#FFFFFF',
  accentText: '#9A3524',
  borderStrong: '#8F7B6F',
  border: '#E6D8CC',
  danger: '#B3261E',
  onDanger: '#FFFFFF',
  success: '#1F6B45',
  focusRing: '#7A2E20',
  overlay: 'rgba(42, 29, 25, 0.5)',
};

export const darkColors: ColorTokens = {
  background: '#1B1411',
  surface: '#271D19',
  surfaceMuted: '#322620',
  text: '#F7ECE4',
  textMuted: '#C9B6AA',
  accent: '#E88A74',
  onAccent: '#2A1410',
  accentText: '#F2A28D',
  borderStrong: '#9C8579',
  border: '#3F312A',
  danger: '#FF9C92',
  onDanger: '#2A0F0C',
  success: '#7FD3A4',
  focusRing: '#F2A28D',
  overlay: 'rgba(0, 0, 0, 0.6)',
};

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}
