import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { gql, startGateway, type TestGateway } from './support/gateway.js';

/**
 * Phone numbers arrive in GraphQL variables and literals. They must never reach the gateway's
 * logs or its error responses (CLAUDE.md rule 3). The harness plants a synthetic number.
 */
describe('gateway privacy', () => {
  const privacy = usePrivacyHarness();
  const identity = new FakeIdentity();
  let gateway: TestGateway;

  beforeAll(async () => {
    await identity.start();
    gateway = await startGateway(identity, {
      logger: createLogger({
        service: 'gateway',
        level: 'trace',
        destination: privacy.logs.destination,
      }),
    });
  });

  afterAll(async () => {
    await gateway.service.shutdown('test');
    await identity.stop();
  });

  it('keeps the number out of logs and responses on success and failure', async () => {
    const phone = privacy.markers.phone();
    identity.handlers.set('requestOtp', () => ({
      challengeId: 'c',
      expiresAt: new Date(),
      retryAfterSeconds: 60,
    }));
    const responses = [
      await gql(gateway.url, 'mutation ($p: String!) { requestOtp(phone: $p) { challengeId } }', {
        variables: { p: phone },
      }),
    ];
    identity.handlers.set('requestOtp', () => {
      throw new GrpcFailure(status.INTERNAL, `failed for ${phone}`);
    });
    responses.push(
      await gql(gateway.url, 'mutation ($p: String!) { requestOtp(phone: $p) { challengeId } }', {
        variables: { p: phone },
      }),
      await gql(
        gateway.url,
        `mutation { requestOtp(phone: ${phone.replace(/\D/g, '')}) { challengeId } }`,
      ),
      await gql(gateway.url, `{ account(phone: "${phone}") { id } }`),
    );
    for (const response of responses)
      privacy.http.record(
        {
          method: 'POST',
          url: gateway.url,
          status: response.status,
          body: JSON.stringify(response.body),
        },
        { recordRequestUrl: false },
      );
  });
});
