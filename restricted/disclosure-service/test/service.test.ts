import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { AppModule } from '../src/app.module.js';
import { disclosureConfig } from '../src/config.js';

const freePort = (): Promise<number> =>
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

describe('disclosure-service service', () => {
  let service: RunningService;
  let http: string;

  beforeAll(async () => {
    const httpPort = await freePort();
    http = `http://127.0.0.1:${String(httpPort)}`;
    service = await bootstrapService({
      module: AppModule,
      extraConfig: disclosureConfig,
      loggerMode: 'allowlist',
      telemetry: false,
      env: {
        // Nothing listens here: the service must start, but report the vault as not ready.
        VAULT_DATABASE_URL: 'postgres://disclosure:unused-password@127.0.0.1:1/chronos_vault',
        NODE_ENV: 'test',
        SERVICE_NAME: 'disclosure-service',
        HTTP_PORT: String(httpPort),
        GRPC_PORT: String(await freePort()),
        SHUTDOWN_DRAIN_MS: '0',
      },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
      exit: () => undefined,
    });
  });

  afterAll(async () => {
    await service.shutdown('test');
  });

  it('is live, and not ready while the vault is unreachable', async () => {
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
    const ready = await fetch(`${http}/readyz`);
    expect(ready.status).toBe(503);
    const body = await ready.text();
    expect(body).toContain('vault');
    // Check names only: never the connection string or the driver's error text.
    expect(body).not.toMatch(/unused-password|127\.0\.0\.1|ECONNREFUSED/);
  });

  it('turns unexpected errors into a generic response', async () => {
    const response = await fetch(`${http}/no-such-route`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('no-such-route-secret');
  });
});
