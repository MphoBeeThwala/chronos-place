import { describe, expect, it } from 'vitest';
import { ACCOUNT, setup } from './support/harness.js';

const JHB = { latitude: -26.2, longitude: 28.05 };
let n = 0;
const id = () => `77777777-7777-4777-8777-${String((n += 1)).padStart(12, '0')}`;

describe('discovery candidates (M3.2, ADR-0026)', () => {
  async function world() {
    const ctx = setup();
    const { service, facts } = ctx;
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    facts.facts.set(ACCOUNT, { age: 30, verified: false });
    const member = async (age: number | undefined) => {
      const m = id();
      await service.update(m, { displayName: 'Member', intent: 'dating' });
      await service.setLocation(m, JHB);
      if (age !== undefined) facts.facts.set(m, { age, verified: false });
      return m;
    };
    return { ...ctx, member };
  }

  it('asks for a profile, then a location, before finding anyone', async () => {
    const { service } = setup();
    expect((await service.candidates(ACCOUNT, 10)).outcome).toBe('no_profile');
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    expect(await service.candidates(ACCOUNT, 10)).toEqual({
      outcome: 'no_location',
      candidates: [],
      next: undefined,
    });
  });

  it("keeps only active members inside the viewer's age range (both-way fit, approved)", async () => {
    const { service, member } = await world();
    await service.updatePreferences(ACCOUNT, { ageMin: 25, ageMax: 35 });
    await service.setLocation(ACCOUNT, JHB);
    const [inRange, tooYoung, tooOld, inactive] = [
      await member(28),
      await member(22),
      await member(40),
      await member(undefined),
    ];
    const page = await service.candidates(ACCOUNT, 10);
    expect(page.outcome).toBe('ok');
    expect(page.candidates).toMatchObject([{ accountId: inRange, privateMode: false }]);
    expect(page.next).toBeUndefined();
    for (const left of [tooYoung, tooOld, inactive]) {
      expect(page.candidates.map((c) => c.accountId)).not.toContain(left);
    }
  });

  it('gives a next position when the page is full, even if ages filtered some out', async () => {
    const { service, member } = await world();
    await service.setLocation(ACCOUNT, JHB);
    const members = [await member(17 + 50), await member(30), await member(30)];
    await service.updatePreferences(ACCOUNT, { ageMin: 18, ageMax: 60 });
    const first = await service.candidates(ACCOUNT, 2);
    expect(first.next).toBeDefined();
    const second = await service.candidates(ACCOUNT, 2, first.next);
    expect(second.next).toBeUndefined();
    expect([...first.candidates, ...second.candidates].map((c) => c.accountId).sort()).toEqual(
      members.filter((_, i) => i > 0).sort(),
    );
  });

  it('sees nobody when the viewer is not active', async () => {
    const { service, facts, member } = await world();
    await service.setLocation(ACCOUNT, JHB);
    await member(30);
    facts.facts.delete(ACCOUNT);
    expect((await service.candidates(ACCOUNT, 10)).candidates).toEqual([]);
  });
});

describe('private mode in public profiles (ADR-0023)', () => {
  it('shows a private profile only to members its owner liked', async () => {
    const { service, facts, blocks } = setup();
    const [owner, liked, other] = [id(), id(), id()];
    for (const m of [owner, liked, other]) {
      await service.update(m, { displayName: 'Member', intent: 'dating' });
      facts.facts.set(m, { age: 30, verified: false });
    }
    await service.update(owner, { privateMode: true });
    blocks.likes.add(`${owner}:${liked}`);
    expect((await service.publicProfiles(liked, [owner])).map((p) => p.accountId)).toEqual([owner]);
    expect(await service.publicProfiles(other, [owner])).toEqual([]);
    // Nobody is told the profile is private.
    expect(Object.keys((await service.publicProfiles(liked, [owner]))[0] ?? {})).not.toContain(
      'privateMode',
    );
  });
});

describe('ranking features (M3.3, ADR-0027)', () => {
  it('scores closeness, activity, mutual fit, completeness and newness from 0 to 100', async () => {
    const { service, facts, store } = setup();
    const now = new Date();
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.setLocation(ACCOUNT, JHB);
    await service.updatePreferences(ACCOUNT, { maxDistanceKm: 10 });
    facts.facts.set(ACCOUNT, { age: 30, verified: false });

    const full = id();
    await service.update(full, {
      displayName: 'Complete',
      intent: 'dating',
      bio: 'Synthetic bio',
      prompts: [
        { promptId: 'perfect-sunday', answer: 'A' },
        { promptId: 'laugh', answer: 'B' },
        { promptId: 'proud-of', answer: 'C' },
      ],
      interests: ['hiking', 'cooking', 'baking'],
    });
    await service.setLocation(full, JHB);
    facts.facts.set(full, { age: 31, verified: true, activity: 'today' });

    const sparse = id();
    await service.update(sparse, { displayName: 'Sparse', intent: 'dating' });
    // About 5.5 km away, half the viewer's 10 km.
    await service.setLocation(sparse, { latitude: -26.25, longitude: 28.05 });
    await service.updatePreferences(sparse, { maxDistanceKm: 1, intents: ['friendship'] });
    facts.facts.set(sparse, { age: 31, verified: false, activity: 'this_month' });
    store.createdAt.set(sparse, new Date(now.getTime() - 7 * 86_400_000));
    store.createdAt.set(full, now);

    const page = await service.candidates(ACCOUNT, 10);
    const by = new Map(page.candidates.map((c) => [c.accountId, c.features]));
    expect(by.get(full)).toEqual({
      closeness: 100,
      activity: 100,
      mutualFit: 100,
      // Bio 20 + prompts 25 + interests 10 + verified 25 (no photo in this store).
      completeness: 80,
      newness: 100,
    });
    const other = by.get(sparse);
    expect(other?.closeness).toBeGreaterThan(40);
    expect(other?.closeness).toBeLessThan(55);
    expect(other).toMatchObject({ activity: 30, mutualFit: 0, completeness: 0 });
    expect(other?.newness).toBeGreaterThanOrEqual(49);
    expect(other?.newness).toBeLessThanOrEqual(51);
    // Numbers only: nothing about health, and no distance or date.
    for (const features of by.values()) {
      expect(Object.keys(features).sort()).toEqual([
        'activity',
        'closeness',
        'completeness',
        'mutualFit',
        'newness',
      ]);
    }
  });

  it('counts a member with no activity bucket as not recently active', async () => {
    const { service, facts } = setup();
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.setLocation(ACCOUNT, JHB);
    facts.facts.set(ACCOUNT, { age: 30, verified: false });
    const m = id();
    await service.update(m, { displayName: 'Member', intent: 'dating' });
    await service.setLocation(m, JHB);
    facts.facts.set(m, { age: 30, verified: false });
    expect((await service.candidates(ACCOUNT, 10)).candidates[0]?.features.activity).toBe(0);
  });
});

describe('activity stays in ranking (ADR-0027)', () => {
  it('never reaches a profile card, and is not even asked for there', async () => {
    const { service, facts } = setup();
    const [viewer, other] = [id(), id()];
    for (const m of [viewer, other]) {
      await service.update(m, { displayName: 'Member', intent: 'dating' });
      facts.facts.set(m, { age: 30, verified: true, activity: 'today' });
    }
    const cards = await service.publicProfiles(viewer, [other]);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toMatch(/activity|today/);
  });
});
