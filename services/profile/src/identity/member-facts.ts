import { fileURLToPath } from 'node:url';
import { credentials, loadPackageDefinition, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

/** Age in whole years and the verified badge (ADR-0023 decision f). Never a date of birth. */
export interface MemberFact {
  age: number;
  verified: boolean;
}

/** Facts for the active members among `ids`; any other id is missing from the map. */
export interface MemberFacts {
  get(ids: readonly string[]): Promise<Map<string, MemberFact>>;
  close(): void;
}

const IDENTITY_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/identity/v1/identity.proto'),
);
const TIMEOUT_MS = 2_000;

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

/**
 * Identity's GetMemberFacts over gRPC. mTLS and the per-method allow-list arrive with M2.5, which
 * must add the profile service as an allowed caller of this one method.
 */
export class IdentityMemberFacts implements MemberFacts {
  readonly #client: { getMemberFacts: Unary; close: () => void };

  constructor(address: string) {
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
    this.#client = new pkg.chronos.identity.v1.IdentityService(
      address,
      credentials.createInsecure(),
    ) as { getMemberFacts: Unary; close: () => void };
  }

  get(ids: readonly string[]): Promise<Map<string, MemberFact>> {
    if (ids.length === 0) return Promise.resolve(new Map<string, MemberFact>());
    return new Promise<Map<string, MemberFact>>((resolve, reject) => {
      this.#client.getMemberFacts(
        { accountIds: [...ids] },
        new Metadata(),
        { deadline: new Date(Date.now() + TIMEOUT_MS) },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          const members =
            (response as { members?: { accountId: string; age: number; verified: boolean }[] })
              .members ?? [];
          resolve(new Map(members.map((m) => [m.accountId, { age: m.age, verified: m.verified }])));
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
