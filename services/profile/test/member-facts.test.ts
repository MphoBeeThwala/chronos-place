import { fileURLToPath } from 'node:url';
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  type ServiceDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityMemberFacts } from '../src/identity/member-facts.js';

const PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/identity/v1/identity.proto'),
);
const A = '99999999-9999-4999-8999-000000000001';
const B = '99999999-9999-4999-8999-000000000002';

/** Identity's GetMemberFacts on the real contract; every other method is unimplemented. */
const server = new Server();
const requests: unknown[] = [];
let fail = false;
let port = 0;

beforeAll(async () => {
  const pkg = loadPackageDefinition(
    loadSync(PROTO, { keepCase: false, defaults: true }),
  ) as unknown as {
    chronos: { identity: { v1: { IdentityService: { service: ServiceDefinition } } } };
  };
  server.addService(pkg.chronos.identity.v1.IdentityService.service, {
    getMemberFacts: (
      call: { request: { accountIds: string[] } },
      callback: (error: { code: number } | null, response?: unknown) => void,
    ) => {
      requests.push(call.request);
      if (fail) {
        callback({ code: status.UNAVAILABLE });
        return;
      }
      callback(null, { members: [{ accountId: A, age: 29, verified: true }] });
    },
  });
  port = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, p) => {
      if (err) reject(err);
      else resolve(p);
    });
  });
});

afterAll(() => {
  server.forceShutdown();
});

describe('identity member facts client', () => {
  it('asks identity for the ids and maps the answer', async () => {
    const client = new IdentityMemberFacts(`127.0.0.1:${String(port)}`);
    const facts = await client.get([A, B]);
    expect([...facts.entries()]).toEqual([[A, { age: 29, verified: true }]]);
    expect(requests.at(-1)).toEqual({ accountIds: [A, B] });
    client.close();
  });

  it('makes no call for an empty list, and passes failures on', async () => {
    const client = new IdentityMemberFacts(`127.0.0.1:${String(port)}`);
    const before = requests.length;
    expect((await client.get([])).size).toBe(0);
    expect(requests.length).toBe(before);
    fail = true;
    await expect(client.get([A])).rejects.toMatchObject({ code: status.UNAVAILABLE });
    fail = false;
    client.close();
  });
});
