import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { INTERESTS, PROMPTS } from '../src/catalogue.js';
import { cleanText } from '../src/profiles/text.js';
import { ACCOUNT, setup } from './support/harness.js';

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('creating a profile (decision g)', () => {
  it('answers NOT_FOUND before the first save', async () => {
    expect((await domainError(setup().service.getOwn(ACCOUNT))).code).toBe('not_found');
  });

  it('needs a display name and an intent, then starts with the default preferences', async () => {
    const { service } = setup();
    expect((await domainError(service.update(ACCOUNT, { displayName: 'Naledi' }))).code).toBe(
      'invalid_argument',
    );
    const { profile, preferences } = await service.update(ACCOUNT, {
      displayName: '  Naledi ',
      intent: 'long_term',
    });
    expect(profile).toMatchObject({
      displayName: 'Naledi',
      intent: 'long_term',
      bio: null,
      privateMode: false,
      visible: true,
      prompts: [],
      interests: [],
      hasLocation: false,
    });
    expect(preferences).toEqual({
      ageMin: 18,
      ageMax: 99,
      maxDistanceKm: 50,
      intents: [],
      genders: [],
    });
  });
});

describe('updating a profile', () => {
  it('changes only the fields that are given, and an empty string clears an optional one', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating', bio: 'Hello' });
    const { profile } = await service.update(ACCOUNT, { pronouns: 'she/her', bio: '' });
    expect(profile).toMatchObject({
      displayName: 'Naledi',
      intent: 'dating',
      pronouns: 'she/her',
      bio: null,
    });
  });

  it('refuses a blank display name and text over the limits, with fixed messages', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating' });
    const blank = await domainError(service.update(ACCOUNT, { displayName: '   ' }));
    expect(blank.code).toBe('invalid_argument');
    const long = await domainError(service.update(ACCOUNT, { bio: 'x'.repeat(501) }));
    expect(long.message).toBe('That text is too long.');
    expect((await domainError(service.update(ACCOUNT, { areaLabel: 'y'.repeat(41) }))).code).toBe(
      'invalid_argument',
    );
  });

  it('takes up to 3 distinct prompts from the catalogue and drops empty answers', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating' });
    const [a, b, c, d] = PROMPTS.map((p) => p.id) as [string, string, string, string];
    const { profile } = await service.update(ACCOUNT, {
      prompts: [
        { promptId: a, answer: 'Coffee and a long walk' },
        { promptId: b, answer: '   ' },
      ],
    });
    expect(profile.prompts).toEqual([{ promptId: a, answer: 'Coffee and a long walk' }]);
    for (const prompts of [
      [a, b, c, d].map((promptId) => ({ promptId, answer: 'x' })),
      [
        { promptId: a, answer: 'x' },
        { promptId: a, answer: 'y' },
      ],
      [{ promptId: 'not-in-catalogue', answer: 'x' }],
    ]) {
      expect((await domainError(service.update(ACCOUNT, { prompts }))).code).toBe(
        'invalid_argument',
      );
    }
  });

  it('takes up to 5 interests from the catalogue', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating' });
    const ids = INTERESTS.map((i) => i.id);
    const { profile } = await service.update(ACCOUNT, {
      interests: [ids[2], ids[1], ids[2]] as string[],
    });
    expect(profile.interests).toEqual([ids[1], ids[2]].sort());
    expect((await domainError(service.update(ACCOUNT, { interests: ids.slice(0, 6) }))).code).toBe(
      'invalid_argument',
    );
    expect((await domainError(service.update(ACCOUNT, { interests: ['unknown'] }))).code).toBe(
      'invalid_argument',
    );
  });

  it('keeps private mode and the pause switch as plain settings', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'open' });
    const { profile } = await service.update(ACCOUNT, { privateMode: true, visible: false });
    expect(profile).toMatchObject({ privateMode: true, visible: false });
  });
});

describe('preferences (decision h)', () => {
  it('needs a profile', async () => {
    expect(
      (await domainError(setup().service.updatePreferences(ACCOUNT, { ageMin: 25 }))).code,
    ).toBe('not_found');
  });

  it('never goes below 18 or above 99, and keeps the lowest age first', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating' });
    for (const update of [
      { ageMin: 17 },
      { ageMax: 100 },
      { ageMin: 40, ageMax: 30 },
      { ageMin: 20.5 },
    ]) {
      expect((await domainError(service.updatePreferences(ACCOUNT, update))).code).toBe(
        'invalid_argument',
      );
    }
    const { preferences } = await service.updatePreferences(ACCOUNT, { ageMin: 30, ageMax: 45 });
    expect(preferences).toMatchObject({ ageMin: 30, ageMax: 45 });
  });

  it('keeps distance between 1 and 300 km', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating' });
    for (const maxDistanceKm of [0, 301]) {
      expect((await domainError(service.updatePreferences(ACCOUNT, { maxDistanceKm }))).code).toBe(
        'invalid_argument',
      );
    }
    expect(
      (await service.updatePreferences(ACCOUNT, { maxDistanceKm: 300 })).preferences.maxDistanceKm,
    ).toBe(300);
  });

  it('replaces intents and genders, with duplicates and blanks removed', async () => {
    const { service } = setup();
    await service.update(ACCOUNT, { displayName: 'Naledi', intent: 'dating' });
    const { preferences } = await service.updatePreferences(ACCOUNT, {
      intents: ['open', 'dating', 'open'],
      genders: ['Woman', ' Woman ', '', 'Non-binary'],
    });
    expect(preferences.intents).toEqual(['dating', 'open']);
    expect(preferences.genders).toEqual(['Woman', 'Non-binary']);
  });
});

describe('cleanText', () => {
  it('normalises, strips control and direction-override characters and trims', () => {
    expect(cleanText('  A‮b\u0007c  ', 30)).toBe('Abc');
    expect(cleanText('one\r\ntwo', 30)).toBe('one two');
    expect(cleanText('one\r\n\n\n\ntwo', 30, { multiline: true })).toBe('one\n\ntwo');
    expect(cleanText('Café', 30)).toBe('Café');
    expect(cleanText('   ', 30)).toBeNull();
  });

  it('counts characters as a person does, not bytes, against the limit', () => {
    expect(cleanText('🙂'.repeat(30), 30)).toBe('🙂'.repeat(30));
    expect(cleanText('👋🏾'.repeat(30), 30)).toBe('👋🏾'.repeat(30));
    expect(() => cleanText('🙂'.repeat(31), 30)).toThrow(DomainError);
  });
});

describe('catalogue (decisions c and d)', () => {
  it('has unique ids and no health topics', () => {
    const { prompts, interests } = setup().service.catalogue();
    expect(new Set(prompts.map((p) => p.id)).size).toBe(prompts.length);
    expect(new Set(interests.map((i) => i.id)).size).toBe(interests.length);
    const health =
      /health|diagnos|condition|illness|disease|treatment|medic|hiv|cancer|diabet|body/i;
    for (const text of [...prompts.map((p) => p.question), ...interests.map((i) => i.label)]) {
      expect(text).not.toMatch(health);
    }
  });
});
