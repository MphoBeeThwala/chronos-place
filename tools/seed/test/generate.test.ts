import { describe, expect, it } from 'vitest';
import { AREAS, generate, prng, SEED_ID_PREFIX, seededId } from '../src/generate.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('synthetic members (rule 6)', () => {
  it('is deterministic for a seed and different for another', () => {
    const a = generate({ members: 500, seed: 1 });
    expect(generate({ members: 500, seed: 1 })).toEqual(a);
    expect(generate({ members: 500, seed: 2 }).members[0]?.id).not.toBe(a.members[0]?.id);
  });

  it('marks every id as seeded, as a valid v4 uuid, all unique', () => {
    const random = prng(7);
    const ids = Array.from({ length: 2_000 }, () => seededId(random));
    for (const id of ids) {
      expect(id.startsWith(SEED_ID_PREFIX)).toBe(true);
      expect(id).toMatch(UUID_V4);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places 200,000 members with 25,000 around Johannesburg, on the 1 km grid', () => {
    const { members } = generate();
    expect(members).toHaveLength(200_000);
    expect(members.filter((m) => m.area === 'Johannesburg')).toHaveLength(25_000);
    for (const m of members.slice(0, 5_000)) {
      if (!m.point) continue;
      expect(Math.round(m.point.lat * 100) / 100).toBe(m.point.lat);
      expect(Math.round(m.point.lng * 100) / 100).toBe(m.point.lng);
    }
    expect(AREAS.reduce((sum, a) => sum + a.members, 0)).toBeLessThan(200_000);
  });

  it('keeps every member an adult with preferences inside the allowed ranges', () => {
    const { members } = generate({ members: 20_000 });
    for (const m of members) {
      expect(m.age).toBeGreaterThanOrEqual(18);
      expect(m.prefs.ageMin).toBeGreaterThanOrEqual(18);
      expect(m.prefs.ageMax).toBeLessThanOrEqual(99);
      expect(m.prefs.ageMin).toBeLessThanOrEqual(m.prefs.ageMax);
      expect(m.prefs.maxDistanceKm).toBeGreaterThanOrEqual(1);
      expect(m.prefs.maxDistanceKm).toBeLessThanOrEqual(300);
    }
  });

  it('never decides on yourself and never twice on the same member', () => {
    const { decisions } = generate({ members: 20_000 });
    expect(decisions.length).toBeGreaterThan(0);
    const pairs = decisions.map((d) => `${d.fromId}:${d.toId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(decisions.every((d) => d.fromId !== d.toId)).toBe(true);
  });

  it('has no health fields at all', () => {
    const { members } = generate({ members: 10 });
    const keys = Object.keys(members[0] ?? {}).join(' ');
    expect(keys).not.toMatch(/condition|health|status|diagnos/i);
  });
});
