import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

type Unary = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => void;

type ServiceConstructor = new (address: string, creds: unknown) => unknown;

/**
 * A gRPC client for one service of the contracts, e.g. "chronos.identity.v1.IdentityService".
 * Plain grpc-js: the gateway is an HTTP service, not a Nest microservice. Over mTLS, presenting the
 * gateway's certificate, when `credentials` are given (M2.5).
 */
export class GrpcServiceClient {
  readonly #client: Record<string, Unary> & { close: () => void };
  readonly #timeoutMs: number;
  readonly #name: string;

  constructor(options: {
    address: string;
    protoPath: string;
    service: string;
    timeoutMs?: number;
    credentials?: ChannelCredentials;
  }) {
    const definition = loadSync(options.protoPath, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
    });
    let node: unknown = loadPackageDefinition(definition);
    for (const part of options.service.split('.')) node = (node as Record<string, unknown>)[part];
    const Service = node as ServiceConstructor;
    this.#client = new Service(
      options.address,
      options.credentials ?? credentials.createInsecure(),
    ) as Record<string, Unary> & { close: () => void };
    this.#timeoutMs = options.timeoutMs ?? 3000;
    this.#name = options.service;
  }

  /** Calls a method by its camelCase name, e.g. "verifyOtp". */
  call<T>(
    method: string,
    request: object,
    requestId?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const fn = this.#client[method];
    if (typeof fn !== 'function')
      return Promise.reject(new Error(`unknown method of ${this.#name}`));
    const metadata = new Metadata();
    if (requestId !== undefined) metadata.set('x-request-id', requestId);
    return new Promise<T>((resolve, reject) => {
      fn.call(
        this.#client,
        request,
        metadata,
        { deadline: new Date(Date.now() + (options.timeoutMs ?? this.#timeoutMs)) },
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
