import { describe, expect, it } from 'vitest';
import {
  ageOn,
  isAdult,
  isRealDate,
  MINIMUM_AGE,
  todayInSouthAfrica,
} from '../src/accounts/age.js';

const d = (year: number, month: number, day: number) => ({ year, month, day });

describe('18+ rule (ADR-0018: no under-18s under any circumstance)', () => {
  it('is 18 and is a constant', () => {
    expect(MINIMUM_AGE).toBe(18);
  });

  it('turns 18 on the 18th birthday, not a day before', () => {
    expect(ageOn(d(2008, 11, 20), d(2026, 11, 19))).toBe(17);
    expect(ageOn(d(2008, 11, 20), d(2026, 11, 20))).toBe(18);
    expect(ageOn(d(2008, 11, 20), d(2026, 11, 21))).toBe(18);
  });

  it('treats a 29 February birthday as reached on 1 March in other years', () => {
    expect(ageOn(d(2008, 2, 29), d(2026, 2, 28))).toBe(17);
    expect(ageOn(d(2008, 2, 29), d(2026, 3, 1))).toBe(18);
  });

  it('uses the date in South Africa, not UTC', () => {
    // 23:30 UTC on 19 November is already 20 November in Johannesburg (UTC+2).
    const lateEvening = new Date('2026-11-19T23:30:00Z');
    expect(todayInSouthAfrica(lateEvening)).toEqual(d(2026, 11, 20));
    expect(isAdult(d(2008, 11, 20), lateEvening)).toBe(true);
    expect(isAdult(d(2008, 11, 21), lateEvening)).toBe(false);
  });

  it('rejects dates that do not exist', () => {
    expect(isRealDate(d(2001, 2, 29))).toBe(false);
    expect(isRealDate(d(2000, 2, 29))).toBe(true);
    expect(isRealDate(d(1990, 4, 31))).toBe(false);
    expect(isRealDate(d(1990, 13, 1))).toBe(false);
    expect(isRealDate(d(1990, 0, 1))).toBe(false);
    expect(isRealDate(d(1990.5, 1, 1))).toBe(false);
  });
});
