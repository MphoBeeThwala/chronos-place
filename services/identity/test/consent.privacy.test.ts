import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { describe, expect, it } from 'vitest';
import { ConsentService } from '../src/consent/consent.service.js';
import { CURRENT_POLICIES } from '../src/consent/policies.js';
import { InMemoryConsentStore } from './support/consent-fakes.js';

/**
 * Health consent implies health data: a log line or event saying a member gave or withdrew it
 * would out them (CLAUDE.md rule 3). Logs and published events are scanned here.
 */
describe('consent privacy', () => {
  const privacy = usePrivacyHarness();

  it('says nothing about health consent in logs or events', async () => {
    const store = new InMemoryConsentStore();
    const accountId = '11111111-1111-4111-8111-111111111111';
    const service = new ConsentService({
      consents: store,
      getAccount: () =>
        Promise.resolve({ id: accountId, status: 'active', hasDateOfBirth: true, verified: false }),
      revokeAllSessions: () => Promise.resolve(),
      logger: createLogger({
        service: 'identity',
        level: 'trace',
        destination: privacy.logs.destination,
      }),
    });
    const version = CURRENT_POLICIES.health_processing;
    await service.record(accountId, 'health_processing', version, true);
    await service.record(accountId, 'health_processing', version, false);

    for (const effects of store.effects)
      for (const event of effects.startAccountErasure?.events ?? [])
        privacy.events.publish(event.type, event);
    expect(store.effects.flatMap((e) => e.startAccountErasure?.events ?? [])).toEqual([]);
    for (const line of privacy.logs.texts())
      expect(line).not.toMatch(/health|processing|consent_type/i);
  });
});
