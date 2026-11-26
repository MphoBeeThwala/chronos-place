import { fileURLToPath } from 'node:url';
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { VaultEraser } from './vault-erasure-relay.js';

const DISCLOSURE_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/disclosure/v1/disclosure.proto'),
);
/** Erasure can take a moment (ledger, key, rows); the relay retries on failure anyway. */
const TIMEOUT_MS = 10_000;

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

/**
 * The Disclosure Service's EraseSubject, over mTLS with identity's certificate (identity is its
 * only allowed caller, M2.5). Sends the account id and the request's idempotency key, nothing else.
 */
export class DisclosureEraser implements VaultEraser {
  readonly #client: { eraseSubject: Unary; close: () => void };

  constructor(
    address: string,
    channelCredentials: ChannelCredentials = credentials.createInsecure(),
  ) {
    const definition = loadSync(DISCLOSURE_PROTO, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
    });
    const pkg = loadPackageDefinition(definition) as unknown as {
      chronos: {
        disclosure: {
          v1: { DisclosureService: new (address: string, creds: unknown) => unknown };
        };
      };
    };
    this.#client = new pkg.chronos.disclosure.v1.DisclosureService(address, channelCredentials) as {
      eraseSubject: Unary;
      close: () => void;
    };
  }

  eraseSubject(accountId: string, requestId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#client.eraseSubject(
        { subjectAccountId: accountId, requestId },
        new Metadata(),
        { deadline: new Date(Date.now() + TIMEOUT_MS) },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          if ((response as { completed?: boolean }).completed === true) resolve();
          else reject(new Error('erasure not completed'));
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
