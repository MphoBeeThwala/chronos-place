import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { createAppModule } from '../src/app.module.js';
import { matchingConfig } from '../src/config.js';

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

describe('matching service', () => {
  let service: RunningService;
  let http: string;

  beforeAll(async () => {
    const httpPort = await freePort();
    http = `http://127.0.0.1:${String(httpPort)}`;
    service = await bootstrapService({
      module: createAppModule(),
      extraConfig: matchingConfig,
      env: {
        NODE_ENV: 'test',
        SERVICE_NAME: 'matching',
        HTTP_PORT: String(httpPort),
        GRPC_PORT: String(await freePort()),
        SHUTDOWN_DRAIN_MS: '0',
        // Nothing listens here: the service starts, but is not ready.
        DATABASE_URL: 'postgres://matching:unused-password@127.0.0.1:1/chronos_core',
      },
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
      exit: () => undefined,
    });
  });

  afterAll(async () => {
    await service.shutdown('test');
  });

  it('is live, and not ready without its database', async () => {
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
    const ready = await fetch(`${http}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.text()).not.toMatch(/unused-password|ECONNREFUSED/);
  });

  it('turns unexpected errors into a generic response', async () => {
    const response = await fetch(`${http}/no-such-route`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('no-such-route-secret');
  });
});
