import { describe, expect, it } from 'vitest';
import {
  extraKeys,
  findStigmaTerms,
  flattenEntries,
  flattenKeys,
  missingKeys,
} from '../src/i18n/catalogue';
import { createI18n, DEFAULT_LANGUAGE, pickLanguage, catalogues } from '../src/i18n/index';
import { en } from '../src/i18n/locales/en';

describe('catalogues', () => {
  it('give every language exactly the keys of English (no raw keys shown, none left over)', () => {
    for (const [code, catalogue] of Object.entries(catalogues)) {
      expect(missingKeys(en, catalogue), `${code} is missing keys`).toEqual([]);
      expect(extraKeys(en, catalogue), `${code} has stale keys`).toEqual([]);
    }
  });

  it('detects a catalogue with missing or stale keys', () => {
    const incomplete = { welcome: { title: 'Welkom' }, old: { key: 'x' } };
    expect(missingKeys(en, incomplete)).toContain('welcome.tagline');
    expect(extraKeys(en, incomplete)).toEqual(['old.key']);
  });

  it('have no empty strings', () => {
    for (const [code, catalogue] of Object.entries(catalogues)) {
      for (const [key, value] of flattenEntries(catalogue)) {
        expect(value.trim(), `${code}:${key}`).not.toBe('');
      }
    }
    expect(flattenKeys(en).length).toBeGreaterThan(10);
  });
});

describe('copy is person-first and stigma-free (CLAUDE.md)', () => {
  it('uses none of the stigmatising terms in any language', () => {
    for (const [code, catalogue] of Object.entries(catalogues)) {
      for (const [key, value] of flattenEntries(catalogue)) {
        expect(findStigmaTerms(value), `${code}:${key} -> "${value}"`).toEqual([]);
      }
    }
  });

  it.each([
    ['He is infected', ['infected']],
    ['Victims of illness', ['victims']],
    ['People who suffer from diabetes', ['suffer']],
    ['Diabetics welcome', ['diabetics']],
    ['an AIDS patient', ['aids patient']],
    ['wheelchair-bound users', ['wheelchair-bound']],
    ['Be clean and safe', ['clean']],
  ])('catches "%s"', (text, expected) => {
    expect(findStigmaTerms(text)).toEqual(expected);
  });

  it.each([
    'Living with HIV',
    'A person with diabetes',
    'People who use a wheelchair',
    'Cleanse your search filters',
    'Our service supports you',
  ])('allows "%s"', (text) => {
    expect(findStigmaTerms(text)).toEqual([]);
  });
});

describe('language choice', () => {
  const available = ['en', 'zu', 'af'];

  it('uses an explicit choice when we have it', () => {
    expect(pickLanguage('zu', ['en'], available)).toBe('zu');
  });

  it('falls back to a supported device language, then to English', () => {
    expect(pickLanguage('system', ['xx', 'af', 'en'], available)).toBe('af');
    expect(pickLanguage('system', ['xx'], available)).toBe(DEFAULT_LANGUAGE);
    expect(pickLanguage('xh', ['fr'], available)).toBe(DEFAULT_LANGUAGE);
  });
});

describe('createI18n', () => {
  it('translates and falls back to English for a key a language lacks', () => {
    const translated = { ...en, welcome: { ...en.welcome, title: 'Welkom' } };
    const instance = createI18n({ en, af: translated }, 'af');
    expect(instance.t('welcome.title')).toBe('Welkom');
    expect(instance.t('welcome.tagline')).toBe(en.welcome.tagline);
    void instance.changeLanguage('en');
    expect(instance.t('welcome.title')).toBe('Welcome');
  });
});
