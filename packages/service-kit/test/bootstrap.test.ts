import path from 'node:path';
import { Metadata, status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapService, type RunningService } from '../src/index.js';
import {
  call,
  captureLogger,
  dependencyCheckModule,
  EchoModule,
  ECHO_PROTO,
  freePort,
  grpcClients,
  MARKER,
} from './helpers.js';

const HEALTH_PROTO = path.resolve(import.meta.dirname, '../proto/grpc/health/v1/health.proto');

type Env = Record<string, string>;
const baseEnv = (httpPort: number, grpcPort: number): Env => ({
  NODE_ENV: 'test',
  SERVICE_NAME: 'echo',
  HTTP_PORT: String(httpPort),
  GRPC_PORT: String(grpcPort),
  SHUTDOWN_DRAIN_MS: '0',
});

const running: RunningService[] = [];
let closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  for (const service of running.splice(0)) await service.shutdown('test-cleanup');
});

async function start(
  options: {
    env?: Env;
    module?: ReturnType<typeof dependencyCheckModule>;
    exit?: (code: number) => void;
  } = {},
) {
  const httpPort = await freePort();
  const grpcPort = await freePort();
  const captured = captureLogger();
  const exit = options.exit ?? (() => undefined);
  const service = await bootstrapService({
    module: options.module ?? EchoModule,
    grpc: { packageName: 'chronos.test.v1', protoPath: ECHO_PROTO },
    env: { ...baseEnv(httpPort, grpcPort), ...options.env },
    logger: captured.logger,
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit,
  });
  running.push(service);
  const clients = grpcClients(grpcPort, HEALTH_PROTO);
  closers.push(clients.close);
  return {
    service,
    captured,
    clients,
    http: `http://127.0.0.1:${String(httpPort)}`,
    httpPort,
    grpcPort,
  };
}

describe('configuration', () => {
  it('refuses invalid config and names the variables, not the values', async () => {
    const attempt = bootstrapService({
      module: EchoModule,
      env: { NODE_ENV: 'test', SERVICE_NAME: 'echo', HTTP_PORT: `bad-${MARKER}` },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
    });
    await expect(attempt).rejects.toThrow(/HTTP_PORT/);
    await expect(attempt).rejects.not.toThrow(new RegExp(MARKER));
  });

  it('requires mTLS settings outside local and test', async () => {
    const attempt = bootstrapService({
      module: EchoModule,
      env: { NODE_ENV: 'production', SERVICE_NAME: 'echo' },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
    });
    await expect(attempt).rejects.toThrow(/GRPC_TLS_CERT_PATH: is required in production/);
  });
});

describe('probes', () => {
  it('reports live and ready, and echoes a request id', async () => {
    const { http } = await start();
    const live = await fetch(`${http}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${http}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: {} });
    expect(ready.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports not ready with check names only when a dependency is down', async () => {
    const { http, clients } = await start({
      module: dependencyCheckModule((readiness) => {
        readiness.register('database', () =>
          Promise.reject(new Error(`connection refused ${MARKER}`)),
        );
        readiness.register('cache', () => Promise.resolve());
      }),
    });
    const response = await fetch(`${http}/readyz`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      status: 'unavailable',
      checks: { database: 'down', cache: 'up' },
    });
    expect(text).not.toContain(MARKER);
    expect((await call(clients.health.check({ service: '' }))).status).toBe(2);
  });

  it('answers the standard gRPC health check', async () => {
    const { clients } = await start();
    expect((await call(clients.health.check({ service: '' }))).status).toBe(1);
  });
});

describe('request ids', () => {
  it('uses a safe id from gRPC metadata and puts it on log lines', async () => {
    const { clients, captured } = await start();
    const metadata = new Metadata();
    metadata.set('x-request-id', 'req-from-gateway-123');
    const response = await call(clients.echo.echo({ text: 'hi' }, metadata));
    expect(response.requestId).toBe('req-from-gateway-123');
    const line = captured.lines().find((l) => l['msg'] === 'echo handled');
    expect(line?.['requestId']).toBe('req-from-gateway-123');
  });

  it('replaces an unsafe id', async () => {
    const { clients } = await start();
    const metadata = new Metadata();
    metadata.set('x-request-id', 'not safe: has spaces and punctuation!');
    const response = await call(clients.echo.echo({ text: 'hi' }, metadata));
    expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps an incoming HTTP id and echoes it', async () => {
    const { http } = await start();
    const response = await fetch(`${http}/healthz`, {
      headers: { 'x-request-id': 'req-http-abcdef123' },
    });
    expect(response.headers.get('x-request-id')).toBe('req-http-abcdef123');
  });
});

describe('errors never leak', () => {
  it('maps domain errors to their gRPC code and message', async () => {
    const { clients } = await start();
    await expect(call(clients.echo.fail({ text: '' }))).rejects.toMatchObject({
      code: status.NOT_FOUND,
      details: 'Thing not found',
    });
  });

  it('hides unexpected errors behind a generic gRPC error', async () => {
    const { clients } = await start();
    const error = await call(clients.echo.boom({ text: '' })).catch(
      (e: unknown) => e as { code: number; details: string; message: string },
    );
    expect(error).toMatchObject({ code: status.INTERNAL, details: 'Internal error' });
    expect(JSON.stringify(error)).not.toContain(MARKER);
  });

  it('does the same over HTTP', async () => {
    const { http } = await start();
    const boom = await fetch(`${http}/boom`);
    expect(boom.status).toBe(500);
    const body = await boom.text();
    expect(JSON.parse(body)).toEqual({ error: 'Internal error' });
    expect(body).not.toContain(MARKER);
    const missing = await fetch(`${http}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Thing not found' });
  });
});

describe('graceful shutdown', () => {
  it('reports not ready first, then stops serving, then closes dependencies in reverse order', async () => {
    const exits: number[] = [];
    const events: string[] = [];
    const { service, http } = await start({
      env: { SHUTDOWN_DRAIN_MS: '400' },
      exit: (code) => exits.push(code),
    });
    const serverUp = async (): Promise<boolean> =>
      (await fetch(`${http}/healthz`).catch(() => undefined))?.ok === true;
    service.onClose('first', async () => {
      events.push(`first (server up: ${String(await serverUp())})`);
    });
    service.onClose('second', async () => {
      events.push(`second (server up: ${String(await serverUp())})`);
    });

    const done = service.shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const during = await fetch(`${http}/readyz`);
    expect(during.status).toBe(503);
    expect((await fetch(`${http}/healthz`)).status).toBe(200); // still serving while draining

    await done;
    expect(events).toEqual(['second (server up: false)', 'first (server up: false)']);
    expect(exits).toEqual([0]);
  });

  it('is safe to call twice and exits once', async () => {
    const exits: number[] = [];
    const { service } = await start({ exit: (code) => exits.push(code) });
    await Promise.all([service.shutdown('SIGTERM'), service.shutdown('SIGINT')]);
    expect(exits).toEqual([0]);
  });

  it('exits non-zero when a close step fails, and keeps closing the rest', async () => {
    const exits: number[] = [];
    const closed: string[] = [];
    const { service } = await start({ exit: (code) => exits.push(code) });
    service.onClose('good', () => {
      closed.push('good');
    });
    service.onClose('bad', () => {
      throw new Error('close failed');
    });
    await service.shutdown('SIGTERM');
    expect(closed).toEqual(['good']);
    expect(exits).toEqual([1]);
  });
});
