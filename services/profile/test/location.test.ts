import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { displayDistanceKm, snap } from '../src/profiles/location.js';
import { ACCOUNT, setup } from './support/harness.js';
import { haversineMeters } from './support/profile-fakes.js';

// Synthetic points around Johannesburg and Pretoria, not anyone's real location (rule 6).
const JOBURG = { latitude: -26.2041, longitude: 28.0473 };
const PRETORIA = { latitude: -25.7479, longitude: 28.2293 };

describe('snapping (ADR-0023 decision a)', () => {
  it('stores a point on the 0.01-degree grid, whatever precision is sent', () => {
    expect(snap({ latitude: -26.204123456, longitude: 28.047349999 })).toEqual({
      latitude: -26.2,
      longitude: 28.05,
    });
    expect(snap({ latitude: 0, longitude: -0.004 })).toEqual({ latitude: 0, longitude: -0 });
  });

  it('keeps every snapped point within about 1 km of the cell it came from', () => {
    for (let i = 0; i < 500; i += 1) {
      const point = {
        latitude: -35 + Math.random() * 13,
        longitude: 16 + Math.random() * 17,
      };
      expect(haversineMeters(point, snap(point))).toBeLessThan(800);
    }
  });

  it('rejects positions that are not real', () => {
    for (const point of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: Number.NaN, longitude: 0 },
      { latitude: 0, longitude: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => snap(point)).toThrow(DomainError);
    }
  });
});

describe('displayed distance (M1.5 AC: rounded to at least 1 km)', () => {
  it('is whole kilometres, at least 1, and in 5 km steps above 10 km', () => {
    const cases: [number, number][] = [
      [0, 1],
      [300, 1],
      [1_499, 1],
      [1_500, 2],
      [9_600, 10],
      [10_000, 10],
      [12_400, 10],
      [12_600, 15],
      [54_000, 55],
      [298_000, 300],
    ];
    for (const [meters, km] of cases) expect(displayDistanceKm(meters)).toBe(km);
  });
});

describe('trilateration', () => {
  it('shows the same distances wherever a member stands inside their cell', async () => {
    const { service, facts } = setup();
    const target = '88888888-8888-4888-8888-000000000001';
    facts.facts.set(target, { age: 30, verified: true });
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.update(target, { displayName: 'Target', intent: 'dating' });

    // An attacker moves their own fake position around and reads the distance each time.
    const probes = Array.from({ length: 12 }, (_, i) => ({
      latitude: JOBURG.latitude + (i - 6) * 0.013,
      longitude: JOBURG.longitude + (i % 4) * 0.017,
    }));
    const readings = async (actual: { latitude: number; longitude: number }) => {
      await service.setLocation(target, actual);
      const seen: (number | undefined)[] = [];
      for (const probe of probes) {
        await service.setLocation(ACCOUNT, probe);
        seen.push((await service.publicProfiles(ACCOUNT, [target]))[0]?.distanceKm);
      }
      return seen;
    };
    // Two real positions about 400 m apart in the same cell give the attacker identical readings.
    const a = await readings({ latitude: -26.2005, longitude: 28.0451 });
    const b = await readings({ latitude: -26.2036, longitude: 28.0479 });
    expect(a).toEqual(b);
  });
});

describe('other members’ view', () => {
  it('gives a rounded distance, age and badge, and never a coordinate', async () => {
    const { service, facts } = setup();
    const other = '88888888-8888-4888-8888-000000000002';
    facts.facts.set(other, { age: 34, verified: true });
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.update(other, {
      displayName: 'Sipho',
      intent: 'long_term',
      areaLabel: 'Pretoria East',
    });
    await service.setLocation(ACCOUNT, JOBURG);
    await service.setLocation(other, PRETORIA);

    const [view] = await service.publicProfiles(ACCOUNT, [other]);
    expect(view).toMatchObject({
      accountId: other,
      displayName: 'Sipho',
      age: 34,
      verified: true,
      areaLabel: 'Pretoria East',
      distanceKm: 55,
    });
    const text = JSON.stringify(view);
    for (const coordinate of ['-25.7', '28.2', '-26.2', '28.0', '28.05', '-25.75']) {
      expect(text).not.toContain(coordinate);
    }
  });

  it('has no distance when either member has not shared a location', async () => {
    const { service, facts } = setup();
    const other = '88888888-8888-4888-8888-000000000003';
    facts.facts.set(other, { age: 40, verified: false });
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.update(other, { displayName: 'Lindiwe', intent: 'open' });
    await service.setLocation(other, PRETORIA);
    expect((await service.publicProfiles(ACCOUNT, [other]))[0]?.distanceKm).toBeUndefined();
  });

  it('leaves out the viewer, paused and private profiles, inactive accounts and unknown ids', async () => {
    const { service, facts } = setup();
    const ids = [1, 2, 3, 4, 5].map((n) => `88888888-8888-4888-8888-00000000001${String(n)}`);
    const [shown, paused, hidden, inactive, alsoShown] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const id of ids) await service.update(id, { displayName: 'Member', intent: 'dating' });
    for (const id of [shown, paused, hidden, alsoShown])
      facts.facts.set(id, { age: 25, verified: false });
    facts.facts.set(ACCOUNT, { age: 25, verified: false });
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.update(paused, { visible: false });
    await service.update(hidden, { privateMode: true });

    const unknown = '88888888-8888-4888-8888-000000000099';
    const views = await service.publicProfiles(ACCOUNT, [
      alsoShown,
      ACCOUNT,
      paused,
      unknown,
      hidden,
      inactive,
      shown,
    ]);
    expect(views.map((v) => v.accountId)).toEqual([alsoShown, shown]);
  });

  it('refuses more than 50 profiles in one request', async () => {
    const { service } = setup();
    const ids = Array.from(
      { length: 51 },
      (_, i) => `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`,
    );
    await expect(service.publicProfiles(ACCOUNT, ids)).rejects.toBeInstanceOf(DomainError);
  });

  it('needs a profile before a location can be set, and can clear it', async () => {
    const { service, store } = setup();
    await expect(service.setLocation(ACCOUNT, JOBURG)).rejects.toBeInstanceOf(DomainError);
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    expect((await service.setLocation(ACCOUNT, JOBURG)).profile.hasLocation).toBe(true);
    expect(store.locations.get(ACCOUNT)).toEqual({ latitude: -26.2, longitude: 28.05 });
    expect((await service.setLocation(ACCOUNT, null)).profile.hasLocation).toBe(false);
    expect(store.locations.has(ACCOUNT)).toBe(false);
  });
});
