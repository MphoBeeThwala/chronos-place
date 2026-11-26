import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  status,
  type sendUnaryData,
  type ServerUnaryCall,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisclosureEraser } from '../src/consent/disclosure-eraser.js';

/** A stand-in Disclosure Service built from the real contract. */
const received: unknown[] = [];
let reply: { completed: boolean } | 'fail' = { completed: true };
let server: Server;
let eraser: DisclosureEraser;

beforeAll(async () => {
  const proto = fileURLToPath(
    import.meta.resolve('@chronos/contracts/proto/chronos/disclosure/v1/disclosure.proto'),
  );
  const pkg = loadPackageDefinition(
    loadSync(proto, { keepCase: false, defaults: true }),
  ) as unknown as {
    chronos: { disclosure: { v1: { DisclosureService: { service: never } } } };
  };
  server = new Server();
  server.addService(pkg.chronos.disclosure.v1.DisclosureService.service, {
    eraseSubject: (call: ServerUnaryCall<unknown, unknown>, done: sendUnaryData<unknown>) => {
      received.push(call.request);
      if (reply === 'fail') done({ code: status.UNAVAILABLE, details: 'down' });
      else done(null, reply);
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error) reject(error);
      else resolve(bound);
    });
  });
  eraser = new DisclosureEraser(`127.0.0.1:${String(port)}`);
});

afterAll(() => {
  eraser.close();
  server.forceShutdown();
});

describe('DisclosureEraser', () => {
  it('sends the account id and idempotency key only, and resolves on completion', async () => {
    const accountId = randomUUID();
    const requestId = randomUUID();
    reply = { completed: true };
    await expect(eraser.eraseSubject(accountId, requestId)).resolves.toBeUndefined();
    expect(received.at(-1)).toEqual({ subjectAccountId: accountId, requestId });
  });

  it('rejects when the vault does not confirm or cannot be reached, so the relay retries', async () => {
    reply = { completed: false };
    await expect(eraser.eraseSubject(randomUUID(), randomUUID())).rejects.toThrow(/not completed/);
    reply = 'fail';
    await expect(eraser.eraseSubject(randomUUID(), randomUUID())).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
  });
});
