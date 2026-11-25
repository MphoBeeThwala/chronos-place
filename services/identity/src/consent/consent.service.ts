import { randomUUID } from 'node:crypto';
import { createEvent } from '@chronos/contracts/events';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { SIGN_IN_STATUSES } from '../accounts/account.service.js';
import type { AccountRecord } from '../accounts/account-store.js';
import { CONSENT_TYPES, type ConsentType } from '../db/schema.js';
import type { ConsentEffects, ConsentEntry, ConsentStore } from './consent-store.js';
import { CURRENT_POLICIES, REQUIRED_FOR_ACTIVATION, WITHDRAWAL_ENDS_ACCOUNT } from './policies.js';

const OUTDATED_VERSION = 'This version of the policy is no longer current.';
const ACCOUNT_UNAVAILABLE = 'This account cannot be used.';

export interface ConsentServiceDeps {
  consents: ConsentStore;
  /** Current account state (AccountService.get). */
  getAccount: (accountId: string) => Promise<AccountRecord>;
  /** Ends every session (SessionService.revokeAll). */
  revokeAllSessions: (accountId: string, reason: 'consent_withdrawn') => Promise<void>;
  /** Biometric consent withdrawn: delete the selfie captures and the badge (ADR-0022). */
  forgetVerification?: (accountId: string) => Promise<void>;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
}

export interface RecordResult {
  account: AccountRecord;
}

/**
 * Consent records (TASKS M1.2). History is append-only. Withdrawing health processing queues
 * erasure of the member's health data in the vault; withdrawing terms or privacy starts account
 * deletion and ends every session. Consent changes are never published as events and logs never
 * name the consent type: even "withdrew health consent" implies health data (CLAUDE.md rule 3).
 */
export class ConsentService {
  readonly #d: Required<ConsentServiceDeps>;

  constructor(deps: ConsentServiceDeps) {
    this.#d = {
      now: () => new Date(),
      newId: randomUUID,
      forgetVerification: () => Promise.resolve(),
      ...deps,
    };
  }

  currentPolicies(): { type: ConsentType; version: string }[] {
    return CONSENT_TYPES.map((type) => ({ type, version: CURRENT_POLICIES[type] }));
  }

  async record(
    accountId: string,
    type: ConsentType,
    policyVersion: string,
    granted: boolean,
  ): Promise<RecordResult> {
    if (policyVersion !== CURRENT_POLICIES[type]) {
      throw new DomainError('failed_precondition', OUTDATED_VERSION);
    }
    const account = await this.#d.getAccount(accountId);
    if (!SIGN_IN_STATUSES.includes(account.status)) {
      throw new DomainError('failed_precondition', ACCOUNT_UNAVAILABLE);
    }

    const now = this.#d.now();
    const entry: ConsentEntry = { type, policyVersion, granted, recordedAt: now };
    const effects: ConsentEffects = {};
    const previous = (await this.#d.consents.latest(accountId))[type];

    if (!granted && type === 'health_processing' && previous?.granted === true) {
      effects.vaultErasureRequestId = this.#d.newId();
    }
    const endsAccount = !granted && WITHDRAWAL_ENDS_ACCOUNT.includes(type);
    if (endsAccount) {
      effects.startAccountErasure = {
        events: [
          createEvent(
            'account.erasure_requested',
            'identity',
            { accountId, requestedAt: now.toISOString() },
            { now },
          ),
        ],
      };
    }

    await this.#d.consents.record(this.#d.newId(), accountId, entry, effects);
    if (endsAccount) await this.#d.revokeAllSessions(accountId, 'consent_withdrawn');
    if (!granted && type === 'biometric_verification') await this.#d.forgetVerification(accountId);
    this.#d.logger.info({ accountId }, 'consent recorded');
    return {
      account: endsAccount ? { ...account, status: 'pending_erasure' } : account,
    };
  }

  history(accountId: string): Promise<ConsentEntry[]> {
    return this.#d.consents.history(accountId);
  }

  /** True when the consent is granted at its current version. */
  async hasCurrentConsent(accountId: string, type: ConsentType): Promise<boolean> {
    const entry = (await this.#d.consents.latest(accountId))[type];
    return entry?.granted === true && entry.policyVersion === CURRENT_POLICIES[type];
  }

  /** True when every consent required for activation is granted at its current version. */
  async hasActivationConsents(accountId: string): Promise<boolean> {
    const latest = await this.#d.consents.latest(accountId);
    return REQUIRED_FOR_ACTIVATION.every((type) => {
      const entry = latest[type];
      return entry?.granted === true && entry.policyVersion === CURRENT_POLICIES[type];
    });
  }
}
