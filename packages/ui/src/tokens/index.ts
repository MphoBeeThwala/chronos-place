/**
 * Design-system tokens for Chronos Place.
 *
 * These values are the single source of truth for colour, spacing, typography
 * and motion. They are exported as a TypeScript object (for use in component
 * logic and Tailwind config) and also written as CSS custom properties in
 * tokens.css (for use in Next.js global styles).
 *
 * Person-first language is used throughout — including in colour names.
 * We deliberately avoid red/green for health indicators.
 */

export const colors = {
  // Brand: Chronos Place palette. 500 Terracotta Rose is for the logo and large decorative use;
  // text and buttons use 600 or darker (WCAG AA). 950 is Mulberry Plum.
  brand: {
    50: '#fdf3f3',
    100: '#fbe4e5',
    200: '#f5cbcb', // Soft Blush
    300: '#eca4ac',
    400: '#e07a87',
    500: '#d45b6a', // Terracotta Rose
    600: '#b8434f', // primary (buttons, links)
    700: '#9a3542',
    800: '#7a2c3a',
    900: '#5e2537',
    950: '#4b223d', // Mulberry Plum
  },
  // The rest of the brand board's palette, for illustration and highlights
  palette: {
    mulberryPlum: '#4b223d',
    terracottaRose: '#d45b6a',
    warmAmber: '#e3943d',
    healingSage: '#4a7a6e',
    softBlush: '#f5cbcb',
    creamSand: '#faf2ea',
    caringIndigo: '#2b3a67',
    coralPeach: '#e57255',
    lavenderMist: '#9b7eb0',
    softMoss: '#7b956d',
    warmHoney: '#edaf4b',
    pearlLinen: '#f9f6f0',
  },
  // Neutral (warm, plum-tinted)
  neutral: {
    0: '#fffdfa',
    50: '#f9f6f0',
    100: '#faf2ea',
    200: '#ead9cd',
    300: '#d2b9ab',
    400: '#a8939f',
    500: '#7a5c6e',
    600: '#6b4a5e',
    700: '#4b223d',
    800: '#2f1c29',
    900: '#241520',
    950: '#1e1119',
  },
  // Semantic
  success: {
    light: '#e3eeea',
    DEFAULT: '#3f6b60',
    dark: '#18302a',
  },
  warning: {
    light: '#fbecd6',
    DEFAULT: '#8a5414',
    dark: '#3a2610',
  },
  // Neutral indicator (we do not use red/green for health status — stigma-free design)
  indicator: {
    light: '#ece6f2',
    DEFAULT: '#2b3a67',
    dark: '#2b2140',
  },
  // Destructive (account deletion, block — not health)
  destructive: {
    light: '#fbe3e0',
    DEFAULT: '#a3261e',
    dark: '#3f1512',
  },
} as const;

export const spacing = {
  px: '1px',
  0: '0',
  0.5: '0.125rem',
  1: '0.25rem',
  1.5: '0.375rem',
  2: '0.5rem',
  2.5: '0.625rem',
  3: '0.75rem',
  3.5: '0.875rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  7: '1.75rem',
  8: '2rem',
  9: '2.25rem',
  10: '2.5rem',
  11: '2.75rem',
  12: '3rem',
  14: '3.5rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
  28: '7rem',
  32: '8rem',
  36: '9rem',
  40: '10rem',
  44: '11rem',
  48: '12rem',
  52: '13rem',
  56: '14rem',
  60: '15rem',
  64: '16rem',
  72: '18rem',
  80: '20rem',
  96: '24rem',
} as const;

export const radii = {
  none: '0',
  sm: '0.125rem',
  DEFAULT: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  '3xl': '1.5rem',
  full: '9999px',
} as const;

export const fontSizes = {
  xs: ['0.75rem', { lineHeight: '1rem' }],
  sm: ['0.875rem', { lineHeight: '1.25rem' }],
  base: ['1rem', { lineHeight: '1.5rem' }],
  lg: ['1.125rem', { lineHeight: '1.75rem' }],
  xl: ['1.25rem', { lineHeight: '1.75rem' }],
  '2xl': ['1.5rem', { lineHeight: '2rem' }],
  '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
  '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
  '5xl': ['3rem', { lineHeight: '1' }],
} as const;

export const fontWeights = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const shadows = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  none: 'none',
} as const;

export const transitions = {
  DEFAULT: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
  fast: '100ms cubic-bezier(0.4, 0, 0.2, 1)',
  slow: '300ms cubic-bezier(0.4, 0, 0.2, 1)',
  none: 'none',
} as const;

/** Minimum touch/click target — WCAG 2.2 AA requires 24×24 CSS px; we use 44pt. */
export const minTargetSize = '44px' as const;

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

export const tokens = {
  colors,
  spacing,
  radii,
  fontSizes,
  fontWeights,
  shadows,
  transitions,
  minTargetSize,
  breakpoints,
} as const;

export type Tokens = typeof tokens;
