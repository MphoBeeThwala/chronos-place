import { describe, expect, it } from 'vitest';
import { canSave, COPY, viewerLine } from '@/components/health/health-copy';

describe('viewerLine (approved wording)', () => {
  it('reads like "Thandi, last viewed 3 Nov, 2 times, still shared"', () => {
    expect(
      viewerLine({
        name: 'Thandi',
        lastViewedAt: '2026-11-03T08:00:00.000Z',
        viewCount: 2,
        hasActiveGrant: true,
      }),
    ).toBe('Thandi, last viewed 3 Nov, 2 times, still shared');
  });

  it('names nobody it cannot show, and counts one view as "1 time"', () => {
    expect(
      viewerLine({
        name: null,
        lastViewedAt: '2026-11-03T23:30:00.000Z', // already 4 Nov in Johannesburg
        viewCount: 1,
        hasActiveGrant: false,
      }),
    ).toBe(`${COPY.hiddenViewer}, last viewed 4 Nov, 1 time, not shared`);
  });
});

describe('canSave', () => {
  const ok = { conditions: [{ code: 'hiv' }], freeText: '', note: '' };
  it.each([
    ['a plain profile', ok, true],
    ['no conditions', { ...ok, conditions: [] }, true],
    ['"Other" with own words', { ...ok, conditions: [{ code: 'other' }], freeText: 'Mine' }, true],
    [
      '"Other" without own words',
      { ...ok, conditions: [{ code: 'other' }], freeText: '  ' },
      false,
    ],
    ['a condition twice', { ...ok, conditions: [{ code: 'hiv' }, { code: 'hiv' }] }, false],
    [
      'more than 10',
      { ...ok, conditions: Array.from({ length: 11 }, (_, i) => ({ code: `c${String(i)}` })) },
      false,
    ],
    ['own words over 500', { ...ok, freeText: 'x'.repeat(501) }, false],
    ['a note over 500', { ...ok, note: 'x'.repeat(501) }, false],
  ])('%s', (_name, draft, expected) => {
    expect(canSave(draft)).toBe(expected);
  });
});
