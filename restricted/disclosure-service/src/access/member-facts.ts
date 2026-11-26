import { fileURLToPath } from 'node:url';
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

/** Whether each member is active and verified. Ids that are not active accounts are missing. */
export interface MemberFacts {
  verifiedById(ids: readonly string[]): Promise<Map<string, boolean>>;
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
 * Identity's GetMemberFacts (only active accounts are returned). Sends account ids only; nothing
 * about health. Over mTLS, presenting this service's certificate (M2.5).
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

  verifiedById(ids: readonly string[]): Promise<Map<string, boolean>> {
    return new Promise((resolve, reject) => {
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
            (response as { members?: { accountId: string; verified: boolean }[] }).members ?? [];
          resolve(new Map(members.map((m) => [m.accountId, m.verified])));
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
