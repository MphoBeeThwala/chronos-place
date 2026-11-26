import { describe, expect, it } from 'vitest';
import { rank, RANKING_WEIGHTS, score, type RankingFeatures } from '../src/feed/ranking.js';

const f = (over: Partial<RankingFeatures> = {}): RankingFeatures => ({
  closeness: 0,
  activity: 0,
  mutualFit: 0,
  completeness: 0,
  newness: 0,
  ...over,
});

describe('ranking v1 (M3.3, ADR-0027)', () => {
  it('uses the approved balanced weights, out of 100', () => {
    expect(RANKING_WEIGHTS).toEqual({
      closeness: 30,
      activity: 25,
      mutualFit: 20,
      completeness: 15,
      newness: 10,
    });
    expect(Object.values(RANKING_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const all = f({
      closeness: 100,
      activity: 100,
      mutualFit: 100,
      completeness: 100,
      newness: 100,
    });
    expect(score(all)).toBe(100);
    expect(score(f())).toBe(0);
    expect(score(f({ closeness: 100 }))).toBe(30);
    expect(score(f({ activity: 60, completeness: 40 }))).toBe(15 + 6);
  });

  it('holds signals to 0 to 100, so one bad value cannot dominate', () => {
    expect(score(f({ newness: 10_000 }))).toBe(10);
    expect(score(f({ closeness: -50 }))).toBe(0);
    expect(score(f({ activity: Number.NaN }))).toBe(0);
  });

  it('puts the highest score first and keeps the given order for ties, every time', () => {
    const near = { id: 'near', features: f({ closeness: 100 }) };
    const active = { id: 'active', features: f({ closeness: 40, activity: 100 }) };
    const tieA = { id: 'tie-a', features: f({ completeness: 100 }) };
    const tieB = { id: 'tie-b', features: f({ completeness: 100 }) };
    const input = [tieA, near, tieB, active];
    const once = rank(input).map((c) => c.id);
    expect(once).toEqual(['active', 'near', 'tie-a', 'tie-b']);
    // Deterministic: the same input always gives the same order, and the input is untouched.
    for (let i = 0; i < 5; i += 1) expect(rank(input).map((c) => c.id)).toEqual(once);
    expect(input.map((c) => c.id)).toEqual(['tie-a', 'near', 'tie-b', 'active']);
  });

  it('lets an active, fitting member a little further away outrank an idle one next door', () => {
    const nextDoorIdle = { id: 'idle', features: f({ closeness: 100, completeness: 40 }) };
    const furtherActive = {
      id: 'active',
      features: f({ closeness: 60, activity: 100, mutualFit: 100, completeness: 40 }),
    };
    expect(rank([nextDoorIdle, furtherActive]).map((c) => c.id)).toEqual(['active', 'idle']);
  });
});
