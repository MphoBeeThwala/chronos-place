import { Intent } from '@chronos/contracts/profile';
import { createLogger } from '@chronos/logger';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const identity = new FakeIdentity();
const profile = new FakeProfile();
let gateway: TestGateway;
let n = 0;
/** A fresh active member per test: the gateway caches account state for 15 seconds. */
const member = (verified = false) => {
  n += 1;
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  if (verified) identity.verified.add(id);
  return id;
};
const session = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });

const catalogue = {
  prompts: [
    { id: 'laugh', question: 'The quickest way to make me laugh is…' },
    { id: 'comfort-food', question: 'My comfort food is…' },
  ],
  interests: [
    { id: 'hiking', label: 'Hiking' },
    { id: 'jazz', label: 'Jazz' },
  ],
};

const own = (accountId: string, overrides: Record<string, unknown> = {}) => ({
  profile: {
    accountId,
    displayName: 'Naledi',
    bio: '',
    intent: Intent.INTENT_LONG_TERM,
    gender: 'Woman',
    pronouns: '',
    areaLabel: 'Soweto',
    privateMode: false,
    visible: true,
    prompts: [
      { promptId: 'laugh', answer: 'Bad puns' },
      { promptId: 'retired-prompt', answer: 'Not shown' },
    ],
    interests: ['jazz', 'retired-interest'],
    hasLocation: false,
    ...overrides,
  },
  preferences: {
    ageMin: 25,
    ageMax: 40,
    maxDistanceKm: 50,
    intents: [Intent.INTENT_DATING],
    genders: ['Man'],
  },
});

const ME = `{ me {
  id displayName bio intent gender pronouns areaLabel privateMode visible verified
  photos { id } prompts { id question answer } interests { id label } sharesDistance tier
  preferences { ageMin ageMax maxDistanceKm intents genders }
} }`;

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start()]);
  gateway = await startGateway(identity, {
    profile,
    logger: createLogger({ service: 'gateway', destination: { write: () => undefined } }),
  });
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop()]);
});

beforeEach(() => {
  profile.handlers.clear();
  profile.calls.length = 0;
  profile.handlers.set('getCatalogue', () => catalogue);
  profile.handlers.set('listOwnPhotos', () => ({ photos: [] }));
});

describe('me (ADR-0023)', () => {
  it('maps the profile, fills prompt questions and drops retired catalogue entries', async () => {
    const id = member(true);
    profile.handlers.set('getOwnProfile', () => own(id));
    const result = await gql(gateway.url, ME, await session(id));
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data).toEqual({
      me: {
        id,
        displayName: 'Naledi',
        bio: null,
        intent: 'LONG_TERM',
        gender: 'Woman',
        pronouns: null,
        areaLabel: 'Soweto',
        privateMode: false,
        visible: true,
        verified: true,
        photos: [],
        prompts: [
          { id: 'laugh', question: 'The quickest way to make me laugh is…', answer: 'Bad puns' },
        ],
        interests: [{ id: 'jazz', label: 'Jazz' }],
        sharesDistance: false,
        tier: 'FREE',
        preferences: {
          ageMin: 25,
          ageMax: 40,
          maxDistanceKm: 50,
          intents: ['DATING'],
          genders: ['Man'],
        },
      },
    });
    expect(profile.calls.find((c) => c.method === 'getOwnProfile')?.request).toEqual({
      accountId: id,
    });
  });

  it('answers PROFILE_REQUIRED before the first save', async () => {
    const id = member();
    profile.handlers.set('getOwnProfile', () => {
      throw new GrpcFailure(status.NOT_FOUND, 'Create your profile first.');
    });
    const result = await gql(gateway.url, '{ me { id } }', await session(id));
    expect(codes(result)).toEqual(['PROFILE_REQUIRED']);
  });

  it('is closed to members who have not finished signing up', async () => {
    const id = member();
    identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING);
    const result = await gql(gateway.url, '{ me { id } }', await session(id));
    expect(codes(result)).toEqual(['FORBIDDEN']);
    expect(profile.calls).toHaveLength(0);
  });

  it('caches the catalogue', async () => {
    const id = member();
    const auth = await session(id);
    await gql(
      gateway.url,
      '{ profileCatalogue { prompts { id question } interests { id label } } }',
      auth,
    );
    const result = await gql(gateway.url, '{ profileCatalogue { interests { id } } }', auth);
    expect(result.body.data).toEqual({
      profileCatalogue: { interests: [{ id: 'hiking' }, { id: 'jazz' }] },
    });
    expect(profile.calls.filter((c) => c.method === 'getCatalogue')).toHaveLength(0);
  });
});

describe('updateProfile', () => {
  it('sends only the fields given, as proto3 optionals and lists', async () => {
    const id = member();
    profile.handlers.set('updateProfile', () => own(id));
    const result = await gql(
      gateway.url,
      `mutation { updateProfile(input: {
        displayName: "Naledi", intent: LONG_TERM, bio: "",
        prompts: [{ promptId: "laugh", answer: "Bad puns" }], interests: ["jazz"]
      }) { id } }`,
      await session(id),
    );
    expect(result.body.errors).toBeUndefined();
    expect(profile.calls.find((c) => c.method === 'updateProfile')?.request).toMatchObject({
      accountId: id,
      displayName: 'Naledi',
      bio: '',
      intent: Intent.INTENT_LONG_TERM,
      prompts: { items: [{ promptId: 'laugh', answer: 'Bad puns' }] },
      interests: { ids: ['jazz'] },
    });
    expect(profile.calls.some((c) => c.method === 'setLocation')).toBe(false);
  });

  it('passes a location to the profile service, which snaps it, and never returns it', async () => {
    const id = member();
    profile.handlers.set('updateProfile', () => own(id));
    profile.handlers.set('setLocation', () => own(id, { hasLocation: true }));
    const result = await gql(
      gateway.url,
      'mutation { updateProfile(input: { location: { latitude: -26.204123, longitude: 28.047349 } }) { sharesDistance } }',
      await session(id),
    );
    expect(result.body.data).toEqual({ updateProfile: { sharesDistance: true } });
    expect(profile.calls.find((c) => c.method === 'setLocation')?.request).toMatchObject({
      accountId: id,
      latitude: -26.204123,
      longitude: 28.047349,
    });
    expect(JSON.stringify(result.body)).not.toMatch(/26\.2|28\.04/);
  });

  it('clears a location, and refuses a location and a clear together', async () => {
    const id = member();
    const auth = await session(id);
    profile.handlers.set('updateProfile', () => own(id));
    profile.handlers.set('setLocation', () => own(id));
    await gql(
      gateway.url,
      'mutation { updateProfile(input: { clearLocation: true }) { id } }',
      auth,
    );
    expect(profile.calls.find((c) => c.method === 'setLocation')?.request).toMatchObject({
      clear: true,
    });

    profile.calls.length = 0;
    const both = await gql(
      gateway.url,
      'mutation { updateProfile(input: { clearLocation: true, location: { latitude: 1, longitude: 1 } }) { id } }',
      auth,
    );
    expect(codes(both)).toEqual(['BAD_USER_INPUT']);
    expect(profile.calls).toHaveLength(0);
  });

  it("passes the profile service's fixed messages through", async () => {
    const id = member();
    profile.handlers.set('updateProfile', () => {
      throw new GrpcFailure(status.INVALID_ARGUMENT, 'That text is too long.');
    });
    const result = await gql(
      gateway.url,
      'mutation { updateProfile(input: { bio: "x" }) { id } }',
      await session(id),
    );
    expect(result.body.errors?.[0]).toMatchObject({
      message: 'That text is too long.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('updatePreferences', () => {
  it('sends numbers and lists in the profile contract', async () => {
    const id = member();
    profile.handlers.set('updatePreferences', () => own(id));
    await gql(
      gateway.url,
      'mutation { updatePreferences(input: { ageMin: 30, intents: [DATING, OPEN], genders: [] }) { id } }',
      await session(id),
    );
    expect(profile.calls.find((c) => c.method === 'updatePreferences')?.request).toMatchObject({
      accountId: id,
      ageMin: 30,
      intents: { values: [Intent.INTENT_DATING, Intent.INTENT_OPEN] },
      genders: {},
    });
  });
});

describe('other members’ profiles', () => {
  it('stay closed until matching can apply blocks (M3)', async () => {
    const id = member();
    const result = await gql(gateway.url, `{ profile(id: "${id}") { id } }`, await session(id));
    expect(codes(result)).toEqual(['NOT_AVAILABLE']);
  });
});

describe('when the profile service is down', () => {
  it('answers UNAVAILABLE', async () => {
    const id = member();
    profile.handlers.set('getOwnProfile', () => {
      throw new GrpcFailure(status.UNAVAILABLE, 'connect ECONNREFUSED 10.0.0.12:50053');
    });
    const result = await gql(gateway.url, '{ me { id } }', await session(id));
    expect(result.body.errors?.[0]).toMatchObject({
      message: 'Service unavailable. Try again.',
      extensions: { code: 'UNAVAILABLE' },
    });
  });
});
