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
import { MatchingVisibility } from '../src/matching/visibility.js';

/** A stand-in matching service built from the real contract. */
let answer: string[] | 'fail' = [];
const received: unknown[] = [];
let server: Server;
let client: MatchingVisibility;

beforeAll(async () => {
  const proto = fileURLToPath(
    import.meta.resolve('@chronos/contracts/proto/chronos/matching/v1/matching.proto'),
  );
  const pkg = loadPackageDefinition(
    loadSync(proto, { keepCase: false, defaults: true }),
  ) as unknown as { chronos: { matching: { v1: { MatchingService: { service: never } } } } };
  server = new Server();
  server.addService(pkg.chronos.matching.v1.MatchingService.service, {
    filterVisible: (call: ServerUnaryCall<unknown, unknown>, done: sendUnaryData<unknown>) => {
      received.push(call.request);
      if (answer === 'fail') done({ code: status.UNAVAILABLE, details: 'down' });
      else done(null, { visibleAccountIds: answer });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error) reject(error);
      else resolve(bound);
    });
  });
  client = new MatchingVisibility(`127.0.0.1:${String(port)}`);
});

afterAll(() => {
  client.close();
  server.forceShutdown();
});

describe('MatchingVisibility', () => {
  it('keeps only what matching allows, in the order asked, and nothing extra', async () => {
    const [viewer, a, b, c] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    answer = [c, a, randomUUID()];
    expect(await client.visibleTo(viewer, [a, b, c])).toEqual([a, c]);
    expect(received.at(-1)).toEqual({
      viewerAccountId: viewer,
      candidateAccountIds: [a, b, c],
      privateAccountIds: [],
    });
  });

  it('shows nobody when matching cannot answer (fail closed)', async () => {
    answer = 'fail';
    expect(await client.visibleTo(randomUUID(), [randomUUID()])).toEqual([]);
  });
});
