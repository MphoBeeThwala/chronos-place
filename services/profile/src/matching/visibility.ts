import { fileURLToPath } from 'node:url';
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

/**
 * Which members a viewer may be shown: blocked pairs never see each other (M3.1 AC), and members in
 * private mode only see-able by members they liked (ADR-0023).
 */
export interface BlockVisibility {
  visibleTo(
    viewerId: string,
    ids: readonly string[],
    privateIds?: readonly string[],
  ): Promise<string[]>;
  close?(): void;
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
 * Matching's FilterVisible over mTLS. If matching cannot answer, nobody is shown: a block must
 * never be bypassed because a service is down (fail closed).
 */
export class MatchingVisibility implements BlockVisibility {
  readonly #client: { filterVisible: Unary; close: () => void };

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
      filterVisible: Unary;
      close: () => void;
    };
  }

  visibleTo(
    viewerId: string,
    ids: readonly string[],
    privateIds: readonly string[] = [],
  ): Promise<string[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.#client.filterVisible(
        {
          viewerAccountId: viewerId,
          candidateAccountIds: [...ids],
          privateAccountIds: [...privateIds],
        },
        new Metadata(),
        { deadline: new Date(Date.now() + TIMEOUT_MS) },
        (error, response) => {
          if (error) {
            resolve([]);
            return;
          }
          const visible = new Set(
            (response as { visibleAccountIds?: string[] }).visibleAccountIds ?? [],
          );
          // Only ids that were asked about, in the order asked.
          resolve(ids.filter((id) => visible.has(id)));
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
