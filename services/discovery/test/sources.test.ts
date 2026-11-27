import { FilterOutcome } from '@chronos/contracts/disclosure';
import { CandidatesOutcome } from '@chronos/contracts/profile';
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  type ServiceDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCLOSURE_PROTO, MATCHING_PROTO, PROFILE_PROTO } from '../src/proto.js';
import {
  DependencyUnavailable,
  MatchingFilter,
  ProfileCandidates,
  VaultConditionFilter,
} from '../src/feed/sources.js';
import { member, VIEWER } from './support/fakes.js';

type Handler = (request: Record<string, unknown>) => unknown;
const handlers = new Map<string, Handler>();
const server = new Server();
let profile: ProfileCandidates;
let matching: MatchingFilter;
let vault: VaultConditionFilter;

const service = (protoPath: string, path: string[]) => {
  let node: unknown = loadPackageDefinition(
    loadSync(protoPath, { keepCase: false, longs: String, enums: Number, defaults: true }),
  );
  for (const part of path) node = (node as Record<string, unknown>)[part];
  return (node as { service: ServiceDefinition }).service;
};
const implement = (definition: ServiceDefinition) =>
  Object.fromEntries(
    Object.values(definition).map((m) => [
      m.originalName ?? '',
      (
        call: { request: Record<string, unknown> },
        done: (e: { code: number; details: string } | null, r?: unknown) => void,
      ) => {
        const handler = handlers.get(m.originalName ?? '');
        if (!handler) done({ code: status.UNAVAILABLE, details: 'connect ECONNREFUSED 10.0.0.1' });
        else done(null, handler(call.request));
      },
    ]),
  );

beforeAll(async () => {
  const profileService = service(PROFILE_PROTO, ['chronos', 'profile', 'v1', 'ProfileService']);
  const matchingService = service(MATCHING_PROTO, ['chronos', 'matching', 'v1', 'MatchingService']);
  server.addService(profileService, implement(profileService));
  server.addService(matchingService, implement(matchingService));
  const vaultService = service(DISCLOSURE_PROTO, [
    'chronos',
    'disclosure',
    'v1',
    'DisclosureService',
  ]);
  server.addService(vaultService, implement(vaultService));
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, p) => {
      if (e) reject(e);
      else resolve(p);
    });
  });
  profile = new ProfileCandidates(`127.0.0.1:${String(port)}`);
  matching = new MatchingFilter(`127.0.0.1:${String(port)}`);
  vault = new VaultConditionFilter(`127.0.0.1:${String(port)}`);
});

afterAll(() => {
  profile.close();
  matching.close();
  vault.close();
  server.forceShutdown();
});

describe('profile and matching clients', () => {
  it('asks profile for 500 at a time and reads the outcome and signals', async () => {
    const [id, other] = [member(), member()];
    let asked: Record<string, unknown> | undefined;
    handlers.set('findCandidates', (r) => {
      asked = r;
      return {
        outcome: CandidatesOutcome.CANDIDATES_OUTCOME_OK,
        candidates: [
          {
            accountId: id,
            privateMode: true,
            features: { closeness: 90, activity: 60, mutualFit: 50, completeness: 45, newness: 0 },
          },
          // A candidate with no signals: each counts as 0, never as a lift.
          { accountId: other, privateMode: false },
        ],
        nextPageToken: 'n',
      };
    });
    expect(await profile.page(VIEWER, 't')).toEqual({
      outcome: 'ok',
      candidates: [
        {
          accountId: id,
          privateMode: true,
          features: { closeness: 90, activity: 60, mutualFit: 50, completeness: 45, newness: 0 },
        },
        {
          accountId: other,
          privateMode: false,
          features: { closeness: 0, activity: 0, mutualFit: 0, completeness: 0, newness: 0 },
        },
      ],
      nextPageToken: 'n',
    });
    expect(asked).toEqual({ viewerAccountId: VIEWER, pageSize: 500, pageToken: 't' });
  });

  it("keeps matching's answer to the ids asked, in the order asked", async () => {
    const [a, b, c] = [member(), member(), member()];
    handlers.set('filterCandidates', () => ({ accountIds: [c, a, member()] }));
    expect(await matching.filter(VIEWER, [a, b, c], [b])).toEqual([a, c]);
  });

  it('turns any failure into DependencyUnavailable, without the cause', async () => {
    handlers.delete('filterCandidates');
    handlers.delete('findCandidates');
    const caught = await matching.filter(VIEWER, [member()], []).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DependencyUnavailable);
    expect((caught as Error).message).not.toContain('10.0.0.1');
    await expect(profile.page(VIEWER, '')).rejects.toBeInstanceOf(DependencyUnavailable);
  });

  it('asks the vault with ids only and reads each outcome (M3.4)', async () => {
    const [a, b] = [member(), member()];
    let asked: Record<string, unknown> | undefined;
    const answer = (outcome: number, eligibleAccountIds: string[] = []) => {
      handlers.set('filterEligibleSubjects', (r) => {
        asked = r;
        return { outcome, eligibleAccountIds };
      });
    };
    answer(FilterOutcome.FILTER_OUTCOME_OK, [b, member()]);
    expect(await vault.eligible(VIEWER, [a, b])).toEqual({ outcome: 'ok', eligible: [b] });
    expect(asked).toEqual({ viewerAccountId: VIEWER, candidateAccountIds: [a, b] });
    for (const [wire, outcome] of [
      [FilterOutcome.FILTER_OUTCOME_BELOW_THRESHOLD, 'below_threshold'],
      [FilterOutcome.FILTER_OUTCOME_VIEWER_NOT_SHARING, 'viewer_not_sharing'],
      [FilterOutcome.FILTER_OUTCOME_NO_PREFERENCES, 'no_preferences'],
    ] as const) {
      answer(wire);
      expect(await vault.eligible(VIEWER, [a])).toEqual({ outcome });
    }
    answer(FilterOutcome.FILTER_OUTCOME_UNSPECIFIED);
    await expect(vault.eligible(VIEWER, [a])).rejects.toBeInstanceOf(DependencyUnavailable);
    handlers.delete('filterEligibleSubjects');
    await expect(vault.eligible(VIEWER, [a])).rejects.toBeInstanceOf(DependencyUnavailable);
  });
});
