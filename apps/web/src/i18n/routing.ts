/**
 * Supported locales (TECHNICAL_SPEC §9 and CLAUDE.md).
 * English first; the other bundles are scaffolded and ready for translation.
 */
export const routing = {
  locales: ['en', 'zu', 'xh', 'af', 'st'],
  defaultLocale: 'en',
} as const;

export type Locale = (typeof routing.locales)[number];

/** Cookie holding the member's chosen language. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: string): value is Locale {
  return (routing.locales as readonly string[]).includes(value);
}
