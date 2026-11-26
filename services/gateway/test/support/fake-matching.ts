import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  type ServiceDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { DISCOVERY_PROTO } from '../../src/discovery/discovery-client.js';
import { MATCHING_PROTO } from '../../src/matching/matching-client.js';
import { GrpcFailure } from './fake-identity.js';

type Handler = (request: Record<string, unknown>) => unknown;

/**
 * A stand-in for one service, speaking its real contract over gRPC. Tests add handlers (by camelCase
 * method name, e.g. "getMatch") for what they exercise; anything else answers UNIMPLEMENTED.
 */
class FakeGrpcService {
  readonly handlers = new Map<string, Handler>();
  readonly calls: { method: string; request: Record<string, unknown> }[] = [];
  #server = new Server();
  port = 0;
  readonly #protoPath: string;
  readonly #path: string[];

  constructor(protoPath: string, service: string) {
    this.#protoPath = protoPath;
    this.#path = service.split('.');
  }

  async start(): Promise<void> {
    const definition = loadSync(this.#protoPath, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
    });
    let node: unknown = loadPackageDefinition(definition);
    for (const part of this.#path) node = (node as Record<string, unknown>)[part];
    const { service } = node as { service: ServiceDefinition };
    const implementation = Object.fromEntries(
      Object.values(service).map((method) => {
        const name = method.originalName ?? '';
        return [
          name,
          (
            call: { request: Record<string, unknown> },
            callback: (error: { code: number; details: string } | null, response?: unknown) => void,
          ) => {
            this.calls.push({ method: name, request: call.request });
            const handler = this.handlers.get(name);
            try {
              if (!handler) throw new GrpcFailure(status.UNIMPLEMENTED, 'not in fake');
              callback(null, handler(call.request));
            } catch (error) {
              callback(
                error instanceof GrpcFailure
                  ? { code: error.code, details: error.message }
                  : { code: status.INTERNAL, details: 'fake failure' },
              );
            }
          },
        ];
      }),
    );
    this.#server.addService(service, implementation);
    this.port = await new Promise<number>((resolve, reject) => {
      this.#server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, port) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.tryShutdown(() => {
        resolve();
      });
    });
  }
}

export class FakeMatching extends FakeGrpcService {
  constructor() {
    super(MATCHING_PROTO, 'chronos.matching.v1.MatchingService');
  }
}

export class FakeDiscovery extends FakeGrpcService {
  constructor() {
    super(DISCOVERY_PROTO, 'chronos.discovery.v1.DiscoveryService');
  }
}
