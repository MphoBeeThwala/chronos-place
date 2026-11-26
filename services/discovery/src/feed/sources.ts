import { CandidatesOutcome } from '@chronos/contracts/profile';
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { MATCHING_PROTO, PROFILE_PROTO } from '../proto.js';
import type { RankingFeatures } from './ranking.js';

export type Outcome = 'ok' | 'no_profile' | 'no_location';

export interface Candidate {
  accountId: string;
  privateMode: boolean;
  features: RankingFeatures;
}

export interface CandidatePage {
  outcome: Outcome;
  candidates: Candidate[];
  /** Empty when there are no more. */
  nextPageToken: string;
}

/** Profile's FindCandidates (ADR-0026): nearest first, ids and the private flag only. */
export interface CandidateSource {
  page(viewerId: string, pageToken: string): Promise<CandidatePage>;
  close?(): void;
}

/** Matching's FilterCandidates: drops blocks, members already seen and private non-likers. */
export interface CandidateFilter {
  filter(
    viewerId: string,
    ids: readonly string[],
    privateIds: readonly string[],
  ): Promise<string[]>;
  close?(): void;
}

/** Thrown when a dependency cannot answer: discovery then shows nothing rather than unfiltered. */
export class DependencyUnavailable extends Error {}

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

const TIMEOUT_MS = 2_000;
/** As many as matching takes in one call. */
export const CANDIDATE_PAGE = 500;

function client(protoPath: string, service: string, address: string, creds: ChannelCredentials) {
  const definition = loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
  });
  let node: unknown = loadPackageDefinition(definition);
  for (const part of service.split('.')) node = (node as Record<string, unknown>)[part];
  const Service = node as new (
    address: string,
    creds: unknown,
  ) => Record<string, Unary> & {
    close: () => void;
  };
  const instance = new Service(address, creds);
  return {
    call: <T>(method: string, request: object): Promise<T> =>
      new Promise((resolve, reject) => {
        const fn = instance[method];
        if (!fn) {
          reject(new DependencyUnavailable());
          return;
        }
        fn.call(
          instance,
          request,
          new Metadata(),
          { deadline: new Date(Date.now() + TIMEOUT_MS) },
          (error, response) => {
            // The cause is dropped: its text can name hosts (CLAUDE.md errors standard).
            if (error) reject(new DependencyUnavailable());
            else resolve(response as T);
          },
        );
      }),
    close: () => {
      instance.close();
    },
  };
}

const OUTCOMES = new Map<number, Outcome>([
  [CandidatesOutcome.CANDIDATES_OUTCOME_OK, 'ok'],
  [CandidatesOutcome.CANDIDATES_OUTCOME_NO_PROFILE, 'no_profile'],
  [CandidatesOutcome.CANDIDATES_OUTCOME_NO_LOCATION, 'no_location'],
]);

export class ProfileCandidates implements CandidateSource {
  readonly #client: ReturnType<typeof client>;

  constructor(address: string, creds: ChannelCredentials = credentials.createInsecure()) {
    this.#client = client(PROFILE_PROTO, 'chronos.profile.v1.ProfileService', address, creds);
  }

  async page(viewerId: string, pageToken: string): Promise<CandidatePage> {
    const r = await this.#client.call<{
      outcome: number;
      candidates?: {
        accountId: string;
        privateMode: boolean;
        features?: Partial<RankingFeatures> | null;
      }[];
      nextPageToken: string;
    }>('findCandidates', { viewerAccountId: viewerId, pageSize: CANDIDATE_PAGE, pageToken });
    const outcome = OUTCOMES.get(r.outcome);
    if (outcome === undefined) throw new DependencyUnavailable();
    return {
      outcome,
      // A signal that did not come counts as 0: a missing one never lifts anyone.
      candidates: (r.candidates ?? []).map((c) => ({
        accountId: c.accountId,
        privateMode: c.privateMode,
        features: {
          closeness: c.features?.closeness ?? 0,
          activity: c.features?.activity ?? 0,
          mutualFit: c.features?.mutualFit ?? 0,
          completeness: c.features?.completeness ?? 0,
          newness: c.features?.newness ?? 0,
        },
      })),
      nextPageToken: r.nextPageToken,
    };
  }

  close(): void {
    this.#client.close();
  }
}

export class MatchingFilter implements CandidateFilter {
  readonly #client: ReturnType<typeof client>;

  constructor(address: string, creds: ChannelCredentials = credentials.createInsecure()) {
    this.#client = client(MATCHING_PROTO, 'chronos.matching.v1.MatchingService', address, creds);
  }

  async filter(
    viewerId: string,
    ids: readonly string[],
    privateIds: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const r = await this.#client.call<{ accountIds?: string[] }>('filterCandidates', {
      viewerAccountId: viewerId,
      candidateAccountIds: [...ids],
      privateAccountIds: [...privateIds],
    });
    // Only ids that were asked about, in the order asked.
    const kept = new Set(r.accountIds ?? []);
    return ids.filter((id) => kept.has(id));
  }

  close(): void {
    this.#client.close();
  }
}
