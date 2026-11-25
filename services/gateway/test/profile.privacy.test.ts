import { Intent } from '@chronos/contracts/profile';
import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeProfile } from './support/fake-profile.js';
import { startGateway, type TestGateway } from './support/gateway.js';

/**
 * Coordinates and member text pass through the gateway on their way to the profile service
 * (ADR-0023). Neither may reach a log line, and a coordinate must never come back in a response
 * (CLAUDE.md rules 3 and 8), on success or failure.
 */
describe('profile privacy at the gateway', () => {
  const privacy = usePrivacyHarness();
  const identity = new FakeIdentity();
  const profile = new FakeProfile();
  const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let gateway: TestGateway;

  beforeAll(async () => {
    await Promise.all([identity.start(), profile.start()]);
    identity.statuses.set(member, AccountStatus.ACCOUNT_STATUS_ACTIVE);
    gateway = await startGateway(identity, {
      profile,
      logger: createLogger({
        service: 'gateway',
        level: 'trace',
        // The harness is recreated for each test; write through to the current one.
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
    await Promise.all([identity.stop(), profile.stop()]);
  });

  it('never logs or returns coordinates or what members write', async () => {
    const latitude = privacy.markers.coordinate();
    const bio = privacy.markers.healthText();
    const own = {
      profile: {
        accountId: member,
        displayName: 'Member',
        bio: '',
        intent: Intent.INTENT_DATING,
        gender: '',
        pronouns: '',
        areaLabel: '',
        privateMode: false,
        visible: true,
        hasLocation: true,
      },
      preferences: { ageMin: 18, ageMax: 99, maxDistanceKm: 50 },
    };
    profile.handlers.set('getCatalogue', () => ({ prompts: [], interests: [] }));
    profile.handlers.set('updateProfile', () => own);
    profile.handlers.set('setLocation', () => own);

    const send = async (query: string, variables: Record<string, unknown>) => {
      const response = await fetch(gateway.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `chronos_access=${await identity.token(member)}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      privacy.http.record(
        { method: 'POST', url: '/graphql', status: response.status, body: await response.text() },
        { recordRequestUrl: false },
      );
    };
    const mutation = `mutation ($input: ProfileInput!) { updateProfile(input: $input) { sharesDistance bio } }`;
    const input = { bio, location: { latitude: Number(latitude), longitude: 28.047349 } };

    await send(mutation, { input });
    profile.handlers.set('setLocation', () => {
      throw new GrpcFailure(status.INTERNAL, 'internal failure');
    });
    await send(mutation, { input });
    // Malformed input fails validation; its values must not be echoed either.
    await send(mutation, { input: { ...input, clearLocation: true } });

    // Three responses were scanned; log lines, if any, are scanned when the test ends.
    expect(privacy.http.texts().length).toBeGreaterThanOrEqual(3);
  });
});
