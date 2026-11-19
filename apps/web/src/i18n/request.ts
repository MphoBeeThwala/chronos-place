/**
 * next-intl request configuration (loaded by next-intl/plugin, see next.config.ts).
 *
 * The app does not use locale-prefixed URLs: there is no [locale] route segment, so a prefix
 * such as /zu/feed would not resolve. The locale comes from the NEXT_LOCALE cookie instead
 * (set by a language switcher, to be added with the translations) and falls back to English.
 */
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { isLocale, LOCALE_COOKIE, routing, type Locale } from './routing';

type Messages = Record<string, unknown>;

// Literal import paths, so the restricted-zone boundary rule can check every import.
const loaders: Record<Locale, () => Promise<{ default: Messages }>> = {
  en: () => import('./messages/en.json'),
  zu: () => import('./messages/zu.json'),
  xh: () => import('./messages/xh.json'),
  af: () => import('./messages/af.json'),
  st: () => import('./messages/st.json'),
};

export default getRequestConfig(async () => {
  const requested = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale =
    requested !== undefined && isLocale(requested) ? requested : routing.defaultLocale;
  const messages = (await loaders[locale]()).default;
  return { locale, messages };
});
