import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTURE_PATH } from '../src/verification/capture-route.js';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { startGateway, type TestGateway } from './support/gateway.js';

/**
 * Selfies are biometric information (ADR-0022). The upload route must not log them or echo them
 * in any response, whether the upload succeeds, is malformed or fails inside identity.
 */
describe('capture upload privacy', () => {
  const privacy = usePrivacyHarness();
  const identity = new FakeIdentity();
  const member = '44444444-4444-4444-8444-444444444444';
  let gateway: TestGateway;

  beforeAll(async () => {
    await identity.start();
    identity.statuses.set(member, AccountStatus.ACCOUNT_STATUS_ACTIVE);
    gateway = await startGateway(identity, {
      // The harness is recreated for each test; write through to the current one.
      logger: createLogger({
        service: 'gateway',
        level: 'trace',
        destination: {
          write: (line: string) => {
            privacy.logs.destination.write(line);
          },
        },
      }),
    });
  });

  afterAll(async () => {
    await gateway.service.shutdown('test');
    await identity.stop();
  });

  it('never logs or echoes the images', async () => {
    const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 'Q')]);
    const encoded = image.toString('base64');
    const url = gateway.url.replace('/graphql', CAPTURE_PATH);
    const cookie = `chronos_access=${await identity.token(member)}`;
    const send = async (body: object) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
      return response.text();
    };

    const bodies: string[] = [];
    identity.handlers.set('submitLiveness', () => {
      throw new GrpcFailure(status.INTERNAL, 'internal failure');
    });
    bodies.push(await send({ selfie: encoded, frames: [encoded] }));
    bodies.push(await send({ selfie: `${encoded}!`, frames: [encoded] }));
    identity.handlers.set('submitLiveness', () => ({
      verification: { status: 2, failure: 0, attemptsRemaining: 4, reviewAvailable: false },
    }));
    bodies.push(await send({ selfie: encoded, frames: [encoded] }));

    const needle = encoded.slice(8, 48);
    expect(privacy.logs.texts().length).toBeGreaterThan(0);
    for (const text of [...privacy.logs.texts(), ...bodies]) expect(text).not.toContain(needle);
  });
});
