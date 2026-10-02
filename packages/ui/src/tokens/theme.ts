import { darkColors, lightColors, type ColorTokens } from './colors';
import { motion, radii, spacing, typography } from './layout';

export type Scheme = 'light' | 'dark';
/** What the member chose in Settings. */
export type SchemePreference = 'system' | Scheme;

export interface Theme {
  scheme: Scheme;
  colors: ColorTokens;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
  motion: typeof motion;
}

const base = { spacing, radii, typography, motion };

export const lightTheme: Theme = { scheme: 'light', colors: lightColors, ...base };
export const darkTheme: Theme = { scheme: 'dark', colors: darkColors, ...base };

/** Picks the scheme to show: an explicit choice wins; "system" follows the device, defaulting to light. */
export function resolveScheme(
  preference: SchemePreference,
  system: Scheme | null | undefined,
): Scheme {
  if (preference === 'system') return system === 'dark' ? 'dark' : 'light';
  return preference;
}

export const themeFor = (scheme: Scheme): Theme => (scheme === 'dark' ? darkTheme : lightTheme);
