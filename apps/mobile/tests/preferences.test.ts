import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, sanitizePreferences } from '../src/store/preferences';

describe('sanitizePreferences', () => {
  it('keeps valid stored values', () => {
    expect(sanitizePreferences({ theme: 'dark', language: 'zu' })).toEqual({
      theme: 'dark',
      language: 'zu',
    });
    expect(sanitizePreferences({ theme: 'system', language: 'system' })).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it.each([
    [null],
    [undefined],
    ['dark'],
    [42],
    [{}],
    [{ theme: 'purple', language: 'english-please' }],
    [{ theme: ['dark'], language: { code: 'en' } }],
    [{ theme: 'dark', language: '../../etc' }],
  ])('falls back to the defaults for untrusted input %j', (input) => {
    const result = sanitizePreferences(input);
    expect(['system', 'light', 'dark']).toContain(result.theme);
    expect(result.language).toMatch(/^(system|[a-z]{2,3})$/);
  });

  it('accepts a valid theme next to an invalid language, and the reverse', () => {
    expect(sanitizePreferences({ theme: 'light', language: 'nope!' })).toEqual({
      theme: 'light',
      language: 'system',
    });
    expect(sanitizePreferences({ theme: 'nope', language: 'af' })).toEqual({
      theme: 'system',
      language: 'af',
    });
  });
});
