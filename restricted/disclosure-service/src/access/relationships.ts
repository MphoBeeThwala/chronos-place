import { fileURLToPath } from 'node:url';
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

/** Block and match state between two members, from the matching service (TECHNICAL_SPEC 4.2). */
export interface Relationships {
  between(
    viewerId: string,
    subjectId: string,
  ): Promise<{ blocked: boolean; activeMatch: boolean } | 'unavailable'>;
  close?(): void;
}

/**
 * Used when no matching address is configured: nobody can say whether two members are blocked
 * or matched, so every view and share by someone other than the member is refused (fail closed).
 */
export class MatchingNotYetAvailable implements Relationships {
  between(): Promise<'unavailable'> {
    return Promise.resolve('unavailable');
  }
}

const MATCHING_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/matching/v1/matching.proto'),
);
const TIMEOUT_MS = 2_000;

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

/**
 * Matching's GetRelationship over mTLS (M3.1). Sends two account ids, nothing about health. Any
 * failure is `unavailable`, which the access decision treats as "deny".
 */
export class MatchingRelationships implements Relationships {
  readonly #client: { getRelationship: Unary; close: () => void };

  constructor(
    address: string,
    channelCredentials: ChannelCredentials = credentials.createInsecure(),
  ) {
    const definition = loadSync(MATCHING_PROTO, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
    });
    const pkg = loadPackageDefinition(definition) as unknown as {
      chronos: {
        matching: { v1: { MatchingService: new (address: string, creds: unknown) => unknown } };
      };
    };
    this.#client = new pkg.chronos.matching.v1.MatchingService(address, channelCredentials) as {
      getRelationship: Unary;
      close: () => void;
    };
  }

  between(
    viewerId: string,
    subjectId: string,
  ): Promise<{ blocked: boolean; activeMatch: boolean } | 'unavailable'> {
    return new Promise((resolve) => {
      this.#client.getRelationship(
        { accountId: viewerId, otherAccountId: subjectId },
        new Metadata(),
        { deadline: new Date(Date.now() + TIMEOUT_MS) },
        (error, response) => {
          if (error) {
            resolve('unavailable');
            return;
          }
          const r = response as { blocked?: boolean; activeMatchId?: string };
          resolve({ blocked: r.blocked === true, activeMatch: (r.activeMatchId ?? '') !== '' });
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
