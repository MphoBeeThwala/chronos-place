/**
 * next-intl server-side configuration.
 * Loaded by next-intl/plugin (see next.config.ts).
 */
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing.js';

export default getRequestConfig(async ({ requestLocale }) => {
  // Validate that the locale from the URL is one we support.
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as (typeof routing.locales)[number])) {
    locale = routing.defaultLocale;
  }

  // Dynamically import the message bundle for this locale.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- dynamic JSON import
  const messages = (await import(`./messages/${locale}.json`)).default;

  return { locale, messages };
});
