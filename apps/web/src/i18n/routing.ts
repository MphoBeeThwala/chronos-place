import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  /**
   * Supported locales (TECHNICAL_SPEC §9 and CLAUDE.md).
   * English first; other keys are scaffolded and ready for translation.
   */
  locales: ['en', 'zu', 'xh', 'af', 'st'],
  defaultLocale: 'en',
  // Locale prefix: only add it to the URL for non-default locales.
  localePrefix: 'as-needed',
});

export type Locale = (typeof routing.locales)[number];
