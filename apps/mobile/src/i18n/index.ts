import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en, type Catalogue } from './locales/en';

/** Catalogues by language code. Add isiZulu (`zu`), isiXhosa (`xh`), Afrikaans (`af`) and Sesotho (`st`) here. */
export const catalogues = { en } as const;

/** Language codes we have catalogues for. */
export const availableLanguages = (): string[] => Object.keys(catalogues);

export type Resources = Record<string, Catalogue>;

export const DEFAULT_LANGUAGE = 'en';

/**
 * Chooses the language to show: an explicit choice if we have its catalogue, otherwise the first
 * device language we support, otherwise English.
 */
export function pickLanguage(
  preference: string,
  deviceLanguages: readonly string[],
  available: readonly string[],
): string {
  if (preference !== 'system' && available.includes(preference)) return preference;
  return deviceLanguages.find((code) => available.includes(code)) ?? DEFAULT_LANGUAGE;
}

/** Creates an i18n instance. Initialisation is synchronous because the catalogues are bundled. */
export function createI18n(resources: Resources, language: string): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    resources: Object.fromEntries(
      Object.entries(resources).map(([code, translation]) => [code, { translation }]),
    ),
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

/** The app's instance. The root layout switches its language once preferences have loaded. */
export const i18n = createI18n(catalogues, DEFAULT_LANGUAGE);

/** Languages the member can choose between, each shown in its own name (never translated). */
export const languageNames: Record<string, string> = {
  en: 'English',
  zu: 'isiZulu',
  xh: 'isiXhosa',
  af: 'Afrikaans',
  st: 'Sesotho',
};
