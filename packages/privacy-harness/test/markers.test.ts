import { describe, expect, it } from 'vitest';
import { MarkerSet } from '../src/index.js';

describe('MarkerSet', () => {
  it('is reproducible from a seed and differs between seeds', () => {
    const a = new MarkerSet('seed-one');
    const b = new MarkerSet('seed-one');
    const c = new MarkerSet('seed-two');
    expect([a.healthText(), a.email(), a.phone()]).toEqual([b.healthText(), b.email(), b.phone()]);
    expect(c.healthText()).not.toBe(new MarkerSet('seed-one').healthText());
  });

  it('never repeats a value within a run', () => {
    const markers = new MarkerSet('unique');
    const values = Array.from({ length: 200 }, () => markers.healthText());
    expect(new Set(values).size).toBe(200);
  });

  it('produces realistic, clearly synthetic shapes', () => {
    const markers = new MarkerSet('shapes');
    expect(markers.healthText()).toMatch(/^SYNTH-HEALTH-[0-9a-f]{12}$/);
    expect(markers.conditionCode()).toMatch(/^synth_condition_[0-9a-f]{8}$/);
    expect(markers.email()).toMatch(/^synth\.[0-9a-f]{10}@example\.test$/);
    expect(markers.phone()).toMatch(/^\+27 82 555 \d{4}$/);
    expect(markers.coordinate()).toMatch(/^-26\.\d{6}$/);
    expect(markers.secret()).toMatch(/^synth-secret-[0-9a-f]{24}$/);
  });

  it('records what it generated, by kind', () => {
    const markers = new MarkerSet('record');
    markers.healthText();
    markers.conditionCode();
    markers.email();
    markers.coordinate();
    markers.secret();
    expect(markers.all().map((m) => m.kind)).toEqual([
      'health',
      'health',
      'identity',
      'location',
      'secret',
    ]);
  });

  it('takes the seed from PRIVACY_SEED when none is given', () => {
    process.env['PRIVACY_SEED'] = 'from-env';
    try {
      expect(new MarkerSet().seed).toBe('from-env');
    } finally {
      delete process.env['PRIVACY_SEED'];
    }
  });
});
