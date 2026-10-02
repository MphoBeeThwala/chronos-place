/** Spacing scale in points. */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = { sm: 6, md: 12, lg: 20, pill: 999 } as const;

/** Minimum touch target in points (WCAG 2.2 AA, PRD accessibility requirements). */
export const MIN_TOUCH_TARGET = 44;

/** Text scales with the system setting up to 200% (PRD: "Text scales to 200% without loss of content"). */
export const MAX_FONT_SCALE = 2;

export const typography = {
  sizes: { caption: 12, bodySmall: 14, body: 16, title: 20, heading2: 24, heading1: 30 },
  lineHeights: { caption: 16, bodySmall: 20, body: 24, title: 28, heading2: 32, heading1: 38 },
  weights: { regular: '400', medium: '500', semibold: '600', bold: '700' },
} as const;

/** Durations in milliseconds. Components use zero when reduced motion is on. */
export const motion = { fast: 120, base: 200, slow: 320 } as const;

export type Spacing = keyof typeof spacing;
export type TextVariant = keyof typeof typography.sizes;
