import { fileURLToPath } from 'node:url';
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

/** Age in whole years and the verified badge (ADR-0023 decision f). Never a date of birth. */
export interface MemberFact {
  age: number;
  verified: boolean;
  /** Only when asked for, for ranking (ADR-0027). Never shown to anyone. */
  activity?: ActivityBucket;
}

export type ActivityBucket = 'today' | 'this_week' | 'this_month' | 'longer';

/** Facts for the active members among `ids`; any other id is missing from the map. */
export interface MemberFacts {
  get(ids: readonly string[], options?: { activity?: boolean }): Promise<Map<string, MemberFact>>;
  close(): void;
}

const IDENTITY_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/identity/v1/identity.proto'),
);
const TIMEOUT_MS = 2_000;
/** identity.v1 Activity, by number. */
const ACTIVITY = new Map<number, ActivityBucket>([
  [1, 'today'],
  [2, 'this_week'],
  [3, 'this_month'],
  [4, 'longer'],
]);

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

/**
 * Identity's GetMemberFacts over gRPC, presenting the profile service's certificate (M2.5).
 */
export class IdentityMemberFacts implements MemberFacts {
  readonly #client: { getMemberFacts: Unary; close: () => void };

  constructor(
    address: string,
    channelCredentials: ChannelCredentials = credentials.createInsecure(),
  ) {
    const definition = loadSync(IDENTITY_PROTO, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
    });
    const pkg = loadPackageDefinition(definition) as unknown as {
      chronos: {
        identity: { v1: { IdentityService: new (address: string, creds: unknown) => unknown } };
      };
    };
    this.#client = new pkg.chronos.identity.v1.IdentityService(address, channelCredentials) as {
      getMemberFacts: Unary;
      close: () => void;
    };
  }

  get(
    ids: readonly string[],
    options: { activity?: boolean } = {},
  ): Promise<Map<string, MemberFact>> {
    if (ids.length === 0) return Promise.resolve(new Map<string, MemberFact>());
    return new Promise<Map<string, MemberFact>>((resolve, reject) => {
      this.#client.getMemberFacts(
        { accountIds: [...ids], includeActivity: options.activity === true },
        new Metadata(),
        { deadline: new Date(Date.now() + TIMEOUT_MS) },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          const members =
            (
              response as {
                members?: {
                  accountId: string;
                  age: number;
                  verified: boolean;
                  activity?: number;
                }[];
              }
            ).members ?? [];
          resolve(
            new Map(
              members.map((m) => {
                const activity = ACTIVITY.get(m.activity ?? 0);
                return [
                  m.accountId,
                  { age: m.age, verified: m.verified, ...(activity ? { activity } : {}) },
                ];
              }),
            ),
          );
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
