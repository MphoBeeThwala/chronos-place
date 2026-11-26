import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { status } from '@grpc/grpc-js';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapService,
  grpcClientCredentials,
  isAllowed,
  PERMISSION_DENIED_MESSAGE,
  serviceFromSubjectAltName,
  type AllowList,
  type RunningService,
} from '../src/index.js';
import { generatePki, type Pki } from '../src/pki.js';
import {
  captureLogger,
  ECHO_PROTO,
  EchoModule,
  freePort,
  MARKER,
  type EchoClient,
} from './helpers.js';

const HEALTH_PROTO = path.resolve(import.meta.dirname, '../proto/grpc/health/v1/health.proto');

const ALLOW: AllowList = {
  service: 'chronos.test.v1.EchoService',
  methods: {
    Echo: [
      'gateway',
      { caller: 'moderation', when: (r) => (r as { text?: string }).text === 'moderation' },
    ],
    Fail: ['gateway'],
    // Boom: not listed, so nobody may call it.
  },
};

describe('serviceFromSubjectAltName', () => {
  it.each<[string | undefined, string | undefined]>([
    ['URI:spiffe://chronos-place.internal/gateway, DNS:localhost', 'gateway'],
    ['DNS:localhost, URI:spiffe://chronos-place.internal/disclosure-service', 'disclosure-service'],
    ['URI:spiffe://other.example/gateway', undefined],
    [
      'URI:spiffe://chronos-place.internal/gateway, URI:spiffe://chronos-place.internal/identity',
      undefined,
    ],
    ['URI:spiffe://chronos-place.internal/Gateway', undefined],
    ['URI:spiffe://chronos-place.internal/gateway/extra', undefined],
    ['DNS:gateway', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%s -> %s', (san, expected) => {
    expect(serviceFromSubjectAltName(san)).toBe(expected);
  });
});

describe('isAllowed', () => {
  const echo = '/chronos.test.v1.EchoService/Echo';
  it.each<[string, string, string | undefined, unknown, boolean]>([
    ['listed caller', echo, 'gateway', {}, true],
    ['conditional caller, condition met', echo, 'moderation', { text: 'moderation' }, true],
    ['conditional caller, condition not met', echo, 'moderation', { text: 'x' }, false],
    ['unlisted caller', echo, 'discovery', {}, false],
    ['no identity', echo, undefined, {}, false],
    ['unlisted method', '/chronos.test.v1.EchoService/Boom', 'gateway', {}, false],
    ['inherited property name', '/chronos.test.v1.EchoService/toString', 'gateway', {}, false],
    ['another service', '/chronos.other.v1.Other/Echo', 'gateway', {}, false],
    ['health, any identity', '/grpc.health.v1.Health/Check', undefined, {}, true],
  ])('%s', (_name, method, caller, request, expected) => {
    expect(isAllowed(ALLOW, method, caller, request)).toBe(expected);
  });
});

describe('over real mTLS', () => {
  let dir: string;
  let pki: Pki;
  let rogue: Pki;
  let service: RunningService;
  let port: number;
  const log = captureLogger();
  const clients: { close: () => void }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kit-pki-'));
    pki = generatePki(path.join(dir, 'ours'), [
      'echo-service',
      'gateway',
      'moderation',
      'discovery',
    ]);
    // A different CA issuing a certificate that claims to be the gateway.
    rogue = generatePki(path.join(dir, 'rogue'), ['gateway'], { caName: 'Rogue CA' });
    port = await freePort();
    const server = pki.services['echo-service'];
    service = await bootstrapService({
      module: EchoModule,
      grpc: { packageName: 'chronos.test.v1', protoPath: ECHO_PROTO },
      allowList: ALLOW,
      logger: log.logger,
      env: {
        NODE_ENV: 'test',
        SERVICE_NAME: 'echo-service',
        HTTP_PORT: String(await freePort()),
        GRPC_PORT: String(port),
        SHUTDOWN_DRAIN_MS: '0',
        GRPC_TLS_CERT_PATH: server?.cert ?? '',
        GRPC_TLS_KEY_PATH: server?.key ?? '',
        GRPC_TLS_CA_PATH: pki.ca,
      },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
      exit: () => undefined,
    });
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await service.shutdown('test');
    rmSync(dir, { recursive: true, force: true });
  });

  function client(credentials: ReturnType<typeof grpcClientCredentials>) {
    const proxy = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: ['grpc.health.v1', 'chronos.test.v1'],
        protoPath: [HEALTH_PROTO, ECHO_PROTO],
        url: `localhost:${String(port)}`,
        credentials,
      },
    }) as unknown as ClientGrpc & { close: () => void };
    clients.push(proxy);
    return {
      echo: proxy.getService<EchoClient>('EchoService'),
      health: proxy.getService<{
        check: (r: { service: string }) => Observable<unknown>;
      }>('Health'),
    };
  }
  const as = (name: string, from: Pki = pki, expectedServer = 'echo-service') => {
    const cert = from.services[name];
    return client(
      grpcClientCredentials(
        { GRPC_TLS_CERT_PATH: cert?.cert, GRPC_TLS_KEY_PATH: cert?.key, GRPC_TLS_CA_PATH: pki.ca },
        expectedServer,
      ),
    );
  };
  const errorOf = async (p: Promise<unknown>) =>
    (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: number; details?: string } | undefined;

  it('lets an allowed caller through', async () => {
    expect(await firstValueFrom(as('gateway').echo.echo({ text: 'hello' }))).toMatchObject({
      text: 'hello',
    });
  });

  it('refuses a known service on a method that is not its own (M2.5 AC)', async () => {
    const denied = await errorOf(firstValueFrom(as('discovery').echo.echo({ text: MARKER })));
    expect(denied).toMatchObject({
      code: status.PERMISSION_DENIED,
      details: PERMISSION_DENIED_MESSAGE,
    });
  });

  it('applies conditions on the request', async () => {
    const moderation = as('moderation');
    expect((await errorOf(firstValueFrom(moderation.echo.echo({ text: 'x' }))))?.code).toBe(
      status.PERMISSION_DENIED,
    );
    expect(await firstValueFrom(moderation.echo.echo({ text: 'moderation' }))).toMatchObject({
      text: 'moderation',
    });
  });

  it('refuses everyone on an unlisted method, before the handler runs', async () => {
    expect((await errorOf(firstValueFrom(as('gateway').echo.boom({ text: MARKER }))))?.code).toBe(
      status.PERMISSION_DENIED,
    );
  });

  it('answers health checks for any verified caller', async () => {
    expect(await firstValueFrom(as('discovery').health.check({ service: '' }))).toMatchObject({
      status: 1,
    });
  });

  it('refuses a certificate from another CA at the connection', async () => {
    const forged = await errorOf(firstValueFrom(as('gateway', rogue).echo.echo({ text: 'x' })));
    expect(forged?.code).toBe(status.UNAVAILABLE);
  });

  it('refuses a caller with no certificate at the connection', async () => {
    const anonymous = await errorOf(
      firstValueFrom(
        as('nobody').echo.echo({ text: 'x' }), // no cert configured: insecure client
      ),
    );
    expect(anonymous?.code).toBe(status.UNAVAILABLE);
  });

  it('lets a client refuse a server that is not the one it expects', async () => {
    const wrongServer = await errorOf(
      firstValueFrom(as('gateway', pki, 'identity').echo.echo({ text: 'x' })),
    );
    expect(wrongServer?.code).toBe(status.UNAVAILABLE);
  });

  it('logs denials with the caller and method, never the request', () => {
    const denials = log.lines().filter((l) => l['msg'] === 'grpc caller denied');
    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0]).toMatchObject({
      caller: 'discovery',
      grpcPath: '/chronos.test.v1.EchoService/Echo',
    });
    expect(log.raw()).not.toContain(MARKER);
  });
});

describe('startup', () => {
  it('refuses to start a gRPC service without an allow-list outside local and test', async () => {
    await expect(
      bootstrapService({
        module: EchoModule,
        grpc: { packageName: 'chronos.test.v1', protoPath: ECHO_PROTO },
        logger: captureLogger().logger,
        env: {
          NODE_ENV: 'staging',
          SERVICE_NAME: 'echo-service',
          HTTP_PORT: String(await freePort()),
          GRPC_PORT: String(await freePort()),
          GRPC_TLS_CERT_PATH: '/unused/cert.pem',
          GRPC_TLS_KEY_PATH: '/unused/key.pem',
          GRPC_TLS_CA_PATH: '/unused/ca.pem',
        },
        onInvalidConfig: 'throw',
        installSignalHandlers: false,
        exit: () => undefined,
      }),
    ).rejects.toThrow(/caller allow-list/);
  });
});

describe('TLS off', () => {
  const run = async (nodeEnv: string) => {
    const log = captureLogger();
    const started = bootstrapService({
      module: EchoModule,
      grpc: { packageName: 'chronos.test.v1', protoPath: ECHO_PROTO },
      allowList: ALLOW,
      logger: log.logger,
      env: {
        NODE_ENV: nodeEnv,
        SERVICE_NAME: 'echo-service',
        HTTP_PORT: String(await freePort()),
        GRPC_PORT: String(await freePort()),
        SHUTDOWN_DRAIN_MS: '0',
      },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
      exit: () => undefined,
    });
    return { started, log };
  };

  it('refuses to start in local development without certificates', async () => {
    const { started } = await run('local');
    await expect(started).rejects.toThrow(/pnpm dev:certs/);
  });

  it('runs tests without the guard, and says so', async () => {
    const { started, log } = await run('test');
    const service = await started;
    await service.shutdown('test');
    expect(
      log.lines().some((l) => l['msg'] === 'grpc caller allow-list off: no TLS (test only)'),
    ).toBe(true);
  });
});
