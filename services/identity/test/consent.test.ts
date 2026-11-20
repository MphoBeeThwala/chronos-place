import { parseEvent } from '@chronos/contracts/events';
import { createLogger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import type { AccountRecord } from '../src/accounts/account-store.js';
import { ConsentService } from '../src/consent/consent.service.js';
import { CURRENT_POLICIES } from '../src/consent/policies.js';
import type { AccountStatus } from '../src/db/schema.js';
import { InMemoryConsentStore } from './support/consent-fakes.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function setup(status: AccountStatus = 'pending_onboarding') {
  const store = new InMemoryConsentStore();
  const revoked: string[] = [];
  const lines: string[] = [];
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const account: AccountRecord = { id: ACCOUNT, status, hasDateOfBirth: false };
  const service = new ConsentService({
    consents: store,
    getAccount: () => Promise.resolve(account),
    revokeAllSessions: (id) => {
      revoked.push(id);
      return Promise.resolve();
    },
    logger: createLogger({
      service: 'identity-test',
      level: 'trace',
      destination: { write: (l: string) => void lines.push(l) },
    }),
    now: () => new Date((clock += 1000)),
  });
  return { service, store, revoked, lines };
}

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('recording consent', () => {
  it('keeps a full, ordered history (M1.2 AC: consent history queryable)', async () => {
    const { service } = setup();
    await service.record(ACCOUNT, 'terms', CURRENT_POLICIES.terms, true);
    await service.record(ACCOUNT, 'marketing', CURRENT_POLICIES.marketing, true);
    await service.record(ACCOUNT, 'marketing', CURRENT_POLICIES.marketing, false);
    const history = await service.history(ACCOUNT);
    expect(history.map((h) => [h.type, h.granted])).toEqual([
      ['terms', true],
      ['marketing', true],
      ['marketing', false],
    ]);
    expect(history[0]?.policyVersion).toBe(CURRENT_POLICIES.terms);
  });

  it('refuses a policy version that is not current', async () => {
    const { service, store } = setup();
    expect(
      (await domainError(service.record(ACCOUNT, 'terms', 'terms-2020-01-01', true))).code,
    ).toBe('failed_precondition');
    expect(store.rows).toHaveLength(0);
  });

  it('refuses consent for an account that cannot be used', async () => {
    const { service } = setup('ineligible');
    expect(
      (await domainError(service.record(ACCOUNT, 'terms', CURRENT_POLICIES.terms, true))).code,
    ).toBe('failed_precondition');
  });

  it('lists the current policy versions', () => {
    const { service } = setup();
    expect(service.currentPolicies().map((p) => p.type)).toEqual([
      'terms',
      'privacy',
      'health_processing',
      'marketing',
    ]);
  });
});

describe('activation needs terms and privacy (M1.2 decision a)', () => {
  it('is true only when both are granted at their current versions', async () => {
    const { service } = setup();
    expect(await service.hasActivationConsents(ACCOUNT)).toBe(false);
    await service.record(ACCOUNT, 'terms', CURRENT_POLICIES.terms, true);
    expect(await service.hasActivationConsents(ACCOUNT)).toBe(false);
    await service.record(ACCOUNT, 'privacy', CURRENT_POLICIES.privacy, true);
    expect(await service.hasActivationConsents(ACCOUNT)).toBe(true);
  });

  it('does not count health or marketing consent', async () => {
    const { service } = setup();
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, true);
    await service.record(ACCOUNT, 'marketing', CURRENT_POLICIES.marketing, true);
    expect(await service.hasActivationConsents(ACCOUNT)).toBe(false);
  });
});

describe('withdrawal', () => {
  it('queues health-data erasure when health consent is withdrawn (M1.2 AC)', async () => {
    const { service, store, revoked } = setup('active');
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, true);
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, false);
    expect(store.effects.at(-1)?.vaultErasureRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.effects.at(-1)?.startAccountErasure).toBeUndefined();
    expect(revoked).toEqual([]);
  });

  it('queues nothing when health consent was never given', async () => {
    const { service, store } = setup('active');
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, false);
    expect(store.effects.at(-1)?.vaultErasureRequestId).toBeUndefined();
  });

  it.each(['terms', 'privacy'] as const)(
    'withdrawing %s starts account deletion and ends every session (M1.2 decision c)',
    async (type) => {
      const { service, store, revoked } = setup('active');
      const result = await service.record(ACCOUNT, type, CURRENT_POLICIES[type], false);
      expect(result.account.status).toBe('pending_erasure');
      expect(revoked).toEqual([ACCOUNT]);
      const events = store.effects.at(-1)?.startAccountErasure?.events ?? [];
      expect(events).toHaveLength(1);
      expect(parseEvent('account.erasure_requested', events[0]).data.accountId).toBe(ACCOUNT);
    },
  );

  it('withdrawing marketing changes nothing else', async () => {
    const { service, store, revoked } = setup('active');
    const result = await service.record(ACCOUNT, 'marketing', CURRENT_POLICIES.marketing, false);
    expect(result.account.status).toBe('active');
    expect(store.effects.at(-1)).toEqual({});
    expect(revoked).toEqual([]);
  });
});

describe('privacy (CLAUDE.md rule 3)', () => {
  it('never names the consent type in logs', async () => {
    const { service, lines } = setup('active');
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, true);
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, false);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/health|consent_type|processing/i);
  });

  it('publishes no event for health consent changes', async () => {
    const { service, store } = setup('active');
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, true);
    await service.record(ACCOUNT, 'health_processing', CURRENT_POLICIES.health_processing, false);
    for (const effects of store.effects) expect(effects.startAccountErasure).toBeUndefined();
  });
});
