import { createServer } from 'node:net';
import path from 'node:path';
import { createLogger, currentRequestId, type Logger } from '@chronos/logger';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { ClientProxyFactory, GrpcMethod, Transport, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { DomainError, ReadinessRegistry, SERVICE_LOGGER } from '../src/index.js';

export const MARKER = 'SYNTHETIC-MARKER-7f3a9c';
export const ECHO_PROTO = path.resolve(import.meta.dirname, 'fixtures/echo.proto');

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });

export function captureLogger(): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
  raw: () => string;
} {
  const chunks: string[] = [];
  const logger = createLogger({
    service: 'test-service',
    level: 'trace',
    destination: { write: (chunk: string) => void chunks.push(chunk) },
  });
  const raw = () => chunks.join('');
  return {
    logger,
    raw,
    lines: () =>
      raw()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

@Controller()
export class EchoController {
  readonly #logger: Logger;

  constructor(@Inject(SERVICE_LOGGER) logger: Logger) {
    this.#logger = logger;
  }

  @GrpcMethod('EchoService', 'Echo')
  echo(request: { text: string }): { text: string; requestId: string } {
    this.#logger.info('echo handled');
    return { text: request.text, requestId: currentRequestId() ?? '' };
  }

  @GrpcMethod('EchoService', 'Fail')
  fail(): never {
    throw new DomainError('not_found', 'Thing not found');
  }

  @GrpcMethod('EchoService', 'Boom')
  boom(): never {
    throw new Error(`database exploded for ${MARKER}`);
  }

  @Get('boom')
  httpBoom(): never {
    throw new Error(`database exploded for ${MARKER}`);
  }

  @Get('missing')
  httpMissing(): never {
    throw new DomainError('not_found', 'Thing not found');
  }
}

@Module({ controllers: [EchoController] })
export class EchoModule {}

export function dependencyCheckModule(registered: (readiness: ReadinessRegistry) => void) {
  @Module({})
  class DependencyModule {
    constructor(@Inject(ReadinessRegistry) readiness: ReadinessRegistry) {
      registered(readiness);
    }
  }
  return DependencyModule;
}

export interface EchoClient {
  echo: (
    request: { text: string },
    metadata?: Metadata,
  ) => Observable<{ text: string; requestId: string }>;
  fail: (request: { text: string }) => Observable<unknown>;
  boom: (request: { text: string }) => Observable<unknown>;
}

export interface HealthClient {
  check: (request: { service: string }) => Observable<{ status: number }>;
}

export function grpcClients(
  port: number,
  healthProto: string,
): {
  echo: EchoClient;
  health: HealthClient;
  close: () => void;
} {
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: ['grpc.health.v1', 'chronos.test.v1'],
      protoPath: [healthProto, ECHO_PROTO],
      url: `127.0.0.1:${String(port)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  return {
    echo: proxy.getService<EchoClient>('EchoService'),
    health: proxy.getService<HealthClient>('Health'),
    close: () => {
      proxy.close();
    },
  };
}

export const call = firstValueFrom;
export { Metadata };
