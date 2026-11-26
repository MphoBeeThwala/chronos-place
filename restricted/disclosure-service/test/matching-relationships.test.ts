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
import { MatchingRelationships } from '../src/access/relationships.js';

/** A stand-in matching service built from the real contract. */
const received: unknown[] = [];
let reply: { blocked: boolean; activeMatchId: string } | 'fail' = {
  blocked: false,
  activeMatchId: '',
};
let server: Server;
let client: MatchingRelationships;

beforeAll(async () => {
  const proto = fileURLToPath(
    import.meta.resolve('@chronos/contracts/proto/chronos/matching/v1/matching.proto'),
  );
  const pkg = loadPackageDefinition(
    loadSync(proto, { keepCase: false, defaults: true }),
  ) as unknown as {
    chronos: { matching: { v1: { MatchingService: { service: never } } } };
  };
  server = new Server();
  server.addService(pkg.chronos.matching.v1.MatchingService.service, {
    getRelationship: (call: ServerUnaryCall<unknown, unknown>, done: sendUnaryData<unknown>) => {
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
  client = new MatchingRelationships(`127.0.0.1:${String(port)}`);
});

afterAll(() => {
  client.close();
  server.forceShutdown();
});

describe('MatchingRelationships', () => {
  it('asks about the two ids only, and reads blocks and matches', async () => {
    const [viewer, subject] = [randomUUID(), randomUUID()];
    reply = { blocked: false, activeMatchId: randomUUID() };
    expect(await client.between(viewer, subject)).toEqual({ blocked: false, activeMatch: true });
    expect(received.at(-1)).toEqual({ accountId: viewer, otherAccountId: subject });
    reply = { blocked: true, activeMatchId: '' };
    expect(await client.between(viewer, subject)).toEqual({ blocked: true, activeMatch: false });
  });

  it('answers "unavailable" when matching cannot, so access is refused', async () => {
    reply = 'fail';
    expect(await client.between(randomUUID(), randomUUID())).toBe('unavailable');
    const nowhere = new MatchingRelationships('127.0.0.1:1');
    expect(await nowhere.between(randomUUID(), randomUUID())).toBe('unavailable');
    nowhere.close();
  });
});
