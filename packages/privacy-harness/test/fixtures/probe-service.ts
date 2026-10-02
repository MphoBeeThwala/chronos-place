import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { createLogger, currentRequestId, type Logger } from '@chronos/logger';
import {
  bootstrapService,
  DomainError,
  SERVICE_LOGGER,
  type RunningService,
} from '@chronos/service-kit';
import { Controller, Get, Inject, Module, Query, Res } from '@nestjs/common';
import { ClientProxyFactory, GrpcMethod, Transport, type ClientGrpc } from '@nestjs/microservices';
import pino from 'pino';
import { firstValueFrom, type Observable } from 'rxjs';
import type { LogMode } from '@chronos/logger';
import type { PrivacyHarness } from '../../src/index.js';

export const ECHO_PROTO = path.resolve(import.meta.dirname, 'echo.proto');
const HEALTH_PROTO = path.resolve(
  import.meta.dirname,
  '../../../service-kit/proto/grpc/health/v1/health.proto',
);
const RAW_LOG = Symbol('RAW_LOG');

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });

interface Reply {
  status: (code: number) => { send: (body: unknown) => void };
}

/**
 * A small service with well-behaved routes (`/clean/...`) and deliberately leaky ones (`/leak/...`).
 * The leaky routes exist only to prove that the harness notices a leak.
 */
@Controller()
class ProbeController {
  readonly #logger: Logger;
  readonly #raw: pino.Logger;

  constructor(@Inject(SERVICE_LOGGER) logger: Logger, @Inject(RAW_LOG) raw: pino.Logger) {
    this.#logger = logger;
    this.#raw = raw;
  }

  // ---- well-behaved -------------------------------------------------------------------------
  @Get('clean/log')
  cleanLog(@Query('note') note: string, @Query('email') email: string): { ok: boolean } {
    this.#logger.info({ note, detail: `contact ${email}` }, `handled request for ${email}`);
    return { ok: true };
  }

  @Get('clean/error')
  cleanError(@Query('who') who: string): never {
    throw new Error(`lookup failed for ${who}`);
  }

  @Get('clean/domain')
  cleanDomain(): never {
    throw new DomainError('not_found', 'Thing not found');
  }

  @GrpcMethod('EchoService', 'Echo')
  echo(request: { text: string }): { text: string; requestId: string } {
    this.#logger.info({ text: request.text }, 'echo handled');
    return { text: 'ok', requestId: currentRequestId() ?? '' };
  }

  @GrpcMethod('EchoService', 'Boom')
  boom(request: { text: string }): never {
    throw new Error(`failed for ${request.text}`);
  }

  // ---- deliberately leaky --------------------------------------------------------------------
  @Get('leak/log')
  leakLog(@Query('note') note: string): { ok: boolean } {
    this.#raw.info({ conditions: [note] }, 'unredacted logger used by mistake');
    return { ok: true };
  }

  @Get('leak/field')
  leakField(@Query('note') note: string): { ok: boolean } {
    this.#logger.info({ detail: note }, 'health text under a harmless key');
    return { ok: true };
  }

  @Get('leak/body')
  leakBody(@Query('note') note: string, @Res() reply: Reply): void {
    reply.status(500).send({ error: `failed for ${note}` });
  }

  @Get('leak/echo')
  leakEcho(@Query('note') note: string): { echoed: string } {
    return { echoed: note };
  }
}

export interface Probe {
  service: RunningService;
  http: string;
  grpcPort: number;
  /** Real gRPC client for the probe's EchoService. */
  echo: { echo: (text: string) => Promise<unknown>; boom: (text: string) => Promise<unknown> };
  stop: () => Promise<void>;
}

export interface ProbeOptions {
  harness: PrivacyHarness;
  mode?: LogMode;
  otlpEndpoint?: string;
}

export async function startProbe(options: ProbeOptions): Promise<Probe> {
  const { harness } = options;
  const logger = createLogger({
    service: 'probe',
    level: 'trace',
    mode: options.mode ?? 'redact',
    destination: harness.logs.destination,
  });
  const raw = pino({ level: 'trace' }, harness.logs.destination);

  @Module({ controllers: [ProbeController], providers: [{ provide: RAW_LOG, useValue: raw }] })
  class ProbeModule {}

  const httpPort = await freePort();
  const grpcPort = await freePort();
  const service = await bootstrapService({
    module: ProbeModule,
    grpc: { packageName: 'chronos.test.v1', protoPath: ECHO_PROTO },
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'probe',
      HTTP_PORT: String(httpPort),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      ...(options.otlpEndpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: options.otlpEndpoint } : {}),
    },
    logger,
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit: () => undefined,
  });

  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: ['grpc.health.v1', 'chronos.test.v1'],
      protoPath: [HEALTH_PROTO, ECHO_PROTO],
      url: `127.0.0.1:${String(grpcPort)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  const client = proxy.getService<{
    echo: (r: { text: string }) => Observable<unknown>;
    boom: (r: { text: string }) => Observable<unknown>;
  }>('EchoService');

  const call = async (
    fn: (r: { text: string }) => Observable<unknown>,
    text: string,
  ): Promise<unknown> => {
    try {
      return await firstValueFrom(fn({ text }));
    } catch (error) {
      harness.grpc.recordError(error);
      return undefined;
    }
  };

  return {
    service,
    http: `http://127.0.0.1:${String(httpPort)}`,
    grpcPort,
    echo: {
      echo: (text) => call((r) => client.echo(r), text),
      boom: (text) => call((r) => client.boom(r), text),
    },
    stop: async () => {
      proxy.close();
      await service.shutdown('test');
    },
  };
}

/** A fake OTLP collector. Whatever it receives is exactly what left the service. */
export async function startCollector(
  onTraces: (body: string) => void,
): Promise<{ endpoint: string; stop: () => void }> {
  const port = await freePort();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/v1/traces') onTraces(Buffer.concat(chunks).toString('latin1'));
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  }).listen(port, '127.0.0.1');
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    stop: () => {
      server.close();
    },
  };
}
