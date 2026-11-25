import type { SubjectKeyring } from '@chronos/crypto';
import { createEvent } from '@chronos/contracts/events';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import type { AccountStatus } from '../db/schema.js';
import type { VerifiedPhone } from '../otp/otp.service.js';
import type { AccountRecord, AccountStore } from './account-store.js';
import {
  ageOn,
  type CalendarDate,
  EARLIEST_BIRTH_YEAR,
  MINIMUM_AGE,
  isAdult,
  isRealDate,
  toIsoDate,
  todayInSouthAfrica,
} from './age.js';

/** Statuses that may sign in and hold a session. */
export const SIGN_IN_STATUSES: readonly AccountStatus[] = ['pending_onboarding', 'active'];

const ACCOUNT_UNAVAILABLE = 'This account cannot be used.';
const INVALID_DATE = 'Enter a valid date of birth.';
const ALREADY_SET = 'The date of birth has already been given.';
const CONSENT_FIRST = 'Accept the terms and the privacy policy first.';

export interface SignInResult {
  account: AccountRecord;
  created: boolean;
}

export interface AccountServiceDeps {
  accounts: AccountStore;
  keyring: SubjectKeyring;
  /** Ends every session of an account (SessionService.revokeAll). */
  revokeAllSessions: (accountId: string, reason: 'ineligible') => Promise<void>;
  /** True when terms and privacy are granted at their current versions (ConsentService). */
  hasActivationConsents: (accountId: string) => Promise<boolean>;
  logger: Logger;
  now?: () => Date;
}

export class AccountService {
  readonly #d: Required<AccountServiceDeps>;

  constructor(deps: AccountServiceDeps) {
    this.#d = { now: () => new Date(), ...deps };
  }

  /**
   * Finds or creates the account for a number that has just passed its code check. A new account
   * takes the prospective id the number was sealed under, so nothing is re-encrypted (ADR-0018).
   */
  async signIn(verified: VerifiedPhone): Promise<SignInResult> {
    const existing = await this.#d.accounts.findByPhoneLookup(verified.phoneLookup);
    if (existing) return this.#useExisting(existing, verified);

    const now = this.#d.now();
    const created = createEvent(
      'account.created',
      'identity',
      { accountId: verified.prospectiveAccountId, createdAt: now.toISOString() },
      { now },
    );
    const inserted = await this.#d.accounts.insertPending(
      {
        id: verified.prospectiveAccountId,
        phoneLookup: verified.phoneLookup,
        phoneCiphertext: verified.phoneCiphertext,
        phoneNonce: verified.phoneNonce,
      },
      [created],
    );
    if (!inserted) {
      // Two sign-ins for one new number raced; the other one created the account.
      const winner = await this.#d.accounts.findByPhoneLookup(verified.phoneLookup);
      if (!winner) throw new Error('account vanished after a conflicting insert');
      return this.#useExisting(winner, verified);
    }
    this.#d.logger.info({ accountId: verified.prospectiveAccountId }, 'account created');
    return {
      account: {
        id: verified.prospectiveAccountId,
        status: 'pending_onboarding',
        hasDateOfBirth: false,
        verified: false,
      },
      created: true,
    };
  }

  async #useExisting(account: AccountRecord, verified: VerifiedPhone): Promise<SignInResult> {
    // The number was sealed under a fresh id for this sign-in; that copy is not needed.
    await this.#d.keyring.shred(verified.prospectiveAccountId);
    if (!SIGN_IN_STATUSES.includes(account.status)) {
      throw new DomainError('failed_precondition', ACCOUNT_UNAVAILABLE);
    }
    return { account, created: false };
  }

  /**
   * Age in whole years and the verified flag of active members, for other members to see
   * (ADR-0023 decision f). Dates of birth never leave this service.
   */
  async memberFacts(
    ids: readonly string[],
  ): Promise<{ accountId: string; age: number; verified: boolean }[]> {
    const today = todayInSouthAfrica(this.#d.now());
    const facts = await this.#d.accounts.activeFacts([...new Set(ids)]);
    return facts.flatMap((f) => {
      const [year, month, day] = f.dateOfBirth.split('-').map(Number) as [number, number, number];
      const age = ageOn({ year, month, day }, today);
      // Defensive: an active account is always an adult (ADR-0018).
      return age >= MINIMUM_AGE ? [{ accountId: f.id, age, verified: f.verified }] : [];
    });
  }

  async get(accountId: string): Promise<AccountRecord> {
    const account = await this.#d.accounts.get(accountId);
    if (!account) throw new DomainError('not_found', ACCOUNT_UNAVAILABLE);
    return account;
  }

  /**
   * Applies the 18+ rule (ADR-0018). The date can be given once. Under 18: the account becomes
   * ineligible for good, its sessions end, its key is shredded (the sealed number is then
   * unrecoverable) and the date is not stored. Only the lookup hash remains, blocking the number.
   */
  async setDateOfBirth(accountId: string, dateOfBirth: CalendarDate): Promise<AccountRecord> {
    const now = this.#d.now();
    const today = todayInSouthAfrica(now);
    if (
      !isRealDate(dateOfBirth) ||
      dateOfBirth.year < EARLIEST_BIRTH_YEAR ||
      toIsoDate(dateOfBirth) > toIsoDate(today)
    ) {
      throw new DomainError('invalid_argument', INVALID_DATE);
    }

    const account = await this.get(accountId);
    if (account.status !== 'pending_onboarding' || account.hasDateOfBirth) {
      throw new DomainError('failed_precondition', ALREADY_SET);
    }
    // Onboarding order (M1.2): code, then terms and privacy, then date of birth.
    if (!(await this.#d.hasActivationConsents(accountId))) {
      throw new DomainError('failed_precondition', CONSENT_FIRST);
    }

    if (!isAdult(dateOfBirth, now)) {
      if (!(await this.#d.accounts.markIneligible(accountId))) {
        throw new DomainError('failed_precondition', ALREADY_SET);
      }
      await this.#d.revokeAllSessions(accountId, 'ineligible');
      await this.#d.keyring.shred(accountId);
      this.#d.logger.info({ accountId }, 'account ineligible');
      return { id: accountId, status: 'ineligible', hasDateOfBirth: false, verified: false };
    }

    if (!(await this.#d.accounts.activateWithDateOfBirth(accountId, toIsoDate(dateOfBirth)))) {
      throw new DomainError('failed_precondition', ALREADY_SET);
    }
    this.#d.logger.info({ accountId }, 'account activated');
    return { id: accountId, status: 'active', hasDateOfBirth: true, verified: false };
  }
}
