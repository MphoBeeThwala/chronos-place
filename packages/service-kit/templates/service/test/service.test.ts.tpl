import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { AppModule } from '../src/app.module.js';

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

describe('__NAME__ service', () => {
  let service: RunningService;
  let http: string;

  beforeAll(async () => {
    const httpPort = await freePort();
    http = `http://127.0.0.1:${String(httpPort)}`;
    service = await bootstrapService({
      module: AppModule__LOGGER_OPTION__,
      env: {
        NODE_ENV: 'test',
        SERVICE_NAME: '__NAME__',
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

  it('is live and ready', async () => {
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
    expect((await fetch(`${http}/readyz`)).status).toBe(200);
  });

  it('turns unexpected errors into a generic response', async () => {
    const response = await fetch(`${http}/no-such-route`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('no-such-route-secret');
  });
});
