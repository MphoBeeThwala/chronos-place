import { credentials, loadPackageDefinition, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

/** google.protobuf.Timestamp as proto-loader returns it (longs as strings). */
export interface WireTimestamp {
  seconds: string;
  nanos: number;
}

/**
 * A google.protobuf.Timestamp as a Date. The protobuf runtime can be configured (by the contracts'
 * generated code) to hand Timestamps over as Date objects; plain {seconds, nanos} is handled too.
 */
export const toDate = (t: Date | WireTimestamp | null | undefined): Date => {
  if (t instanceof Date) return t;
  return new Date(Number(t?.seconds ?? 0) * 1000 + Math.floor((t?.nanos ?? 0) / 1_000_000));
};

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

/**
 * gRPC client for chronos.identity.v1.IdentityService. Plain grpc-js: the gateway is an HTTP
 * service, not a Nest microservice. mTLS and the per-method allow-list arrive with M2.5.
 */
export class IdentityClient {
  readonly #client: Record<string, Unary> & { close: () => void };
  readonly #timeoutMs: number;

  constructor(options: { address: string; protoPath: string; timeoutMs?: number }) {
    const definition = loadSync(options.protoPath, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(definition) as unknown as {
      chronos: {
        identity: { v1: { IdentityService: new (address: string, creds: unknown) => unknown } };
      };
    };
    const Service = pkg.chronos.identity.v1.IdentityService;
    this.#client = new Service(options.address, credentials.createInsecure()) as Record<
      string,
      Unary
    > & { close: () => void };
    this.#timeoutMs = options.timeoutMs ?? 3000;
  }

  /** Calls a method by its camelCase name, e.g. "verifyOtp". */
  call<T>(method: string, request: object, requestId?: string): Promise<T> {
    const fn = this.#client[method];
    if (typeof fn !== 'function') return Promise.reject(new Error('unknown identity method'));
    const metadata = new Metadata();
    if (requestId !== undefined) metadata.set('x-request-id', requestId);
    return new Promise<T>((resolve, reject) => {
      fn.call(
        this.#client,
        request,
        metadata,
        { deadline: new Date(Date.now() + this.#timeoutMs) },
        (error, response) => {
          if (error) reject(error);
          else resolve(response as T);
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
