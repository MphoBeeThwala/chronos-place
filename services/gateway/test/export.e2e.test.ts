import { ConsentType, VerificationFailure } from '@chronos/contracts/identity';
import { Intent, PhotoModeration } from '@chronos/contracts/profile';
import { createLogger } from '@chronos/logger';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/limits/rate-limit.js';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

/** "Download my data" through the gateway (TASKS M1.8, ADR-0025). Synthetic data only. */
const identity = new FakeIdentity();
const profile = new FakeProfile();
let gateway: TestGateway;
let n = 0;
const member = () => {
  n += 1;
  const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  return id;
};
const session = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });
const EXPORT = '{ myDataExport { format generatedAt json } }';

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start()]);
  identity.handlers.set('exportAccount', (req) => ({
    account: { accountId: req['accountId'], status: AccountStatus.ACCOUNT_STATUS_ACTIVE },
    phoneE164: '+27820001234',
    dateOfBirth: { year: 1991, month: 6, day: 4 },
    createdAt: at('2026-11-01T08:00:00Z'),
    consents: [
      {
        type: ConsentType.CONSENT_TYPE_TERMS,
        policyVersion: 'terms-2026-11-26',
        granted: true,
        recordedAt: at('2026-11-01T08:01:00Z'),
      },
    ],
    sessions: [
      {
        createdAt: at('2026-11-01T08:00:00Z'),
        lastUsedAt: at('2026-11-02T08:00:00Z'),
        expiresAt: at('2026-12-01T08:00:00Z'),
      },
    ],
    verifications: [
      {
        provider: 'fake',
        outcome: 'failed',
        failure: VerificationFailure.VERIFICATION_FAILURE_POOR_QUALITY,
        createdAt: at('2026-11-02T08:00:00Z'),
        decidedAt: at('2026-11-02T08:00:05Z'),
      },
    ],
  }));
  profile.handlers.set('exportProfile', () => ({
    profile: {
      displayName: 'Lindiwe',
      bio: '',
      intent: Intent.INTENT_FRIENDSHIP,
      gender: '',
      pronouns: 'she/her',
      areaLabel: '',
      privateMode: false,
      visible: true,
      prompts: [{ promptId: 'laugh', answer: 'Synthetic answer' }],
      interests: ['jazz'],
    },
    preferences: { ageMin: 25, ageMax: 40, maxDistanceKm: 50, intents: [Intent.INTENT_DATING] },
    location: { latitude: -26.2, longitude: 28.05, updatedAt: at('2026-11-03T08:00:00Z') },
    photos: [
      {
        position: 0,
        moderation: PhotoModeration.PHOTO_MODERATION_PENDING,
        width: 640,
        height: 480,
        variants: [{ size: 320, url: 'http://127.0.0.1:8333/photo-media/x/320.webp?sig=1' }],
      },
    ],
    createdAt: at('2026-11-01T09:00:00Z'),
    updatedAt: at('2026-11-02T09:00:00Z'),
  }));
  gateway = await startGateway(identity, {
    profile,
    logger: createLogger({ service: 'gateway', destination: { write: () => undefined } }),
  });
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop()]);
});

describe('myDataExport', () => {
  it('returns everything as readable JSON, and is never cached', async () => {
    const id = member();
    const res = await gql(gateway.url, EXPORT, await session(id));
    expect(res.headers.get('cache-control')).toBe('no-store');
    const out = res.body.data?.['myDataExport'] as { format: string; json: string };
    expect(out.format).toBe('chronos-export/1');
    const doc = JSON.parse(out.json) as Record<string, unknown>;
    expect(doc['account']).toEqual({
      id,
      status: 'active',
      phoneNumber: '+27820001234',
      dateOfBirth: '1991-06-04',
      createdAt: '2026-11-01T08:00:00.000Z',
    });
    expect(doc['consents']).toEqual([
      {
        type: 'terms',
        policyVersion: 'terms-2026-11-26',
        granted: true,
        recordedAt: '2026-11-01T08:01:00.000Z',
      },
    ]);
    expect(doc['sessions']).toEqual([
      {
        startedAt: '2026-11-01T08:00:00.000Z',
        lastUsedAt: '2026-11-02T08:00:00.000Z',
        expiresAt: '2026-12-01T08:00:00.000Z',
        endedAt: null,
      },
    ]);
    expect(doc['verifications']).toMatchObject([{ outcome: 'failed', failure: 'poor_quality' }]);
    expect(doc['profile']).toMatchObject({
      displayName: 'Lindiwe',
      bio: null,
      intent: 'friendship',
      pronouns: 'she/her',
      prompts: [{ promptId: 'laugh', answer: 'Synthetic answer' }],
    });
    expect(doc['preferences']).toMatchObject({ intents: ['dating'], genders: [] });
    expect(doc['location']).toMatchObject({ latitude: -26.2, longitude: 28.05 });
    expect(doc['photos']).toEqual([
      {
        position: 0,
        status: 'pending',
        width: 640,
        height: 480,
        links: [{ size: 320, url: 'http://127.0.0.1:8333/photo-media/x/320.webp?sig=1' }],
      },
    ]);
    // Both services were asked only for the signed-in member.
    expect(identity.calls.filter((c) => c.method === 'exportAccount').at(-1)?.request).toEqual({
      accountId: id,
    });
  });

  it('needs a signed-in member', async () => {
    const res = await gql(gateway.url, EXPORT);
    expect(codes(res)).toEqual(['UNAUTHENTICATED']);
  });

  it('allows 5 an hour per member', async () => {
    const id = member();
    const auth = await session(id);
    for (let i = 0; i < RATE_LIMITS.dataExportsPerAccount.limit; i += 1) {
      expect(codes(await gql(gateway.url, EXPORT, auth))).toEqual([]);
    }
    const refused = await gql(gateway.url, EXPORT, auth);
    expect(codes(refused)).toEqual(['RATE_LIMITED']);
    // Another member is unaffected.
    expect(codes(await gql(gateway.url, EXPORT, await session(member())))).toEqual([]);
  });

  it('passes identity’s refusal through without detail', async () => {
    const id = member();
    const before = identity.handlers.get('exportAccount');
    identity.handlers.set('exportAccount', () => {
      throw new GrpcFailure(status.FAILED_PRECONDITION, 'This account cannot be exported.');
    });
    const res = await gql(gateway.url, EXPORT, await session(id));
    expect(res.body.data).toBeNull();
    expect(codes(res)).toHaveLength(1);
    if (before) identity.handlers.set('exportAccount', before);
  });
});
