import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  type ServiceDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { PROFILE_PROTO } from '../../src/profile/profile-client.js';
import { GrpcFailure } from './fake-identity.js';

type Handler = (request: Record<string, unknown>) => unknown;

/**
 * A stand-in for the profile service, speaking the real profile.v1 contract over gRPC. Tests add
 * handlers for the methods they exercise; anything else answers UNIMPLEMENTED.
 */
export class FakeProfile {
  readonly handlers = new Map<string, Handler>();
  readonly calls: { method: string; request: Record<string, unknown> }[] = [];
  #server = new Server();
  port = 0;

  async start(): Promise<void> {
    const definition = loadSync(PROFILE_PROTO, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
    });
    const pkg = loadPackageDefinition(definition) as unknown as {
      chronos: { profile: { v1: { ProfileService: { service: ServiceDefinition } } } };
    };
    const { service } = pkg.chronos.profile.v1.ProfileService;
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
