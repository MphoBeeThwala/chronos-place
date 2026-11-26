import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDisclosure } from './support/fake-disclosure.js';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { startGateway, type TestGateway } from './support/gateway.js';

/**
 * Health data passes through the gateway on its way between the member and the Disclosure Service
 * (M2.8). None of it may reach a log line or an error response (CLAUDE.md rule 3), whatever the
 * service sends back.
 */
describe('health privacy at the gateway', () => {
  const privacy = usePrivacyHarness();
  const identity = new FakeIdentity();
  const disclosure = new FakeDisclosure();
  const member = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let gateway: TestGateway;

  beforeAll(async () => {
    await Promise.all([identity.start(), disclosure.start()]);
    identity.statuses.set(member, AccountStatus.ACCOUNT_STATUS_ACTIVE);
    gateway = await startGateway(identity, {
      disclosure,
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
    await Promise.all([identity.stop(), disclosure.stop()]);
  });

  it('never logs health data, and errors never carry it', async () => {
    const words = privacy.markers.healthText();
    const code = privacy.markers.conditionCode();
    const send = async (query: string, variables: Record<string, unknown>, record: boolean) => {
      const response = await fetch(gateway.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `chronos_access=${await identity.token(member)}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      const body = await response.text();
      // A successful answer to the member themself legitimately holds their data; errors may not.
      if (record) {
        privacy.http.record(
          { method: 'POST', url: '/graphql', status: response.status, body },
          { recordRequestUrl: false },
        );
      }
      return body;
    };
    const save = `mutation ($input: HealthProfileInput!) { upsertHealthProfile(input: $input) { freeText } }`;
    const input = { conditions: [{ code, status: 'LIVING_WITH' }], freeText: words };

    // Success: the member's own data comes back to them, and nothing is logged.
    disclosure.handlers.set('upsertHealthProfile', () => ({ version: 1 }));
    disclosure.handlers.set('getOwnHealthProfile', () => ({
      profile: {
        profile: { conditions: [{ code, status: 1 }], freeText: words, note: '' },
        visibility: 1,
        filterOptIn: false,
        version: 1,
      },
    }));
    expect(await send(save, { input }, false)).toContain(words);

    // Failures whose text echoes the request: none of it may come back.
    for (const failure of [
      status.INVALID_ARGUMENT,
      status.FAILED_PRECONDITION,
      status.ABORTED,
      status.INTERNAL,
    ]) {
      disclosure.handlers.set('upsertHealthProfile', () => {
        throw new GrpcFailure(failure, `rejected ${code}: ${words}`);
      });
      await send(save, { input }, true);
    }
    // Edge validation: an oversized profile is refused without echoing it.
    await send(save, { input: { ...input, note: `${words} ${'x'.repeat(2_000)}` } }, true);

    expect(privacy.http.texts()).toHaveLength(5);
  });
});
