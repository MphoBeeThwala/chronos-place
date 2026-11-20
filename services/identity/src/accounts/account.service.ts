import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import type { AccountStatus } from '../db/schema.js';
import type { VerifiedPhone } from '../otp/otp.service.js';
import type { AccountRecord, AccountStore } from './account-store.js';
import {
  type CalendarDate,
  EARLIEST_BIRTH_YEAR,
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

export interface SignInResult {
  account: AccountRecord;
  created: boolean;
}

export interface AccountServiceDeps {
  accounts: AccountStore;
  keyring: SubjectKeyring;
  /** Ends every session of an account (SessionService.revokeAll). */
  revokeAllSessions: (accountId: string, reason: 'ineligible') => Promise<void>;
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

    const inserted = await this.#d.accounts.insertPending({
      id: verified.prospectiveAccountId,
      phoneLookup: verified.phoneLookup,
      phoneCiphertext: verified.phoneCiphertext,
      phoneNonce: verified.phoneNonce,
    });
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

    if (!isAdult(dateOfBirth, now)) {
      if (!(await this.#d.accounts.markIneligible(accountId))) {
        throw new DomainError('failed_precondition', ALREADY_SET);
      }
      await this.#d.revokeAllSessions(accountId, 'ineligible');
      await this.#d.keyring.shred(accountId);
      this.#d.logger.info({ accountId }, 'account ineligible');
      return { id: accountId, status: 'ineligible', hasDateOfBirth: false };
    }

    if (!(await this.#d.accounts.activateWithDateOfBirth(accountId, toIsoDate(dateOfBirth)))) {
      throw new DomainError('failed_precondition', ALREADY_SET);
    }
    this.#d.logger.info({ accountId }, 'account activated');
    return { id: accountId, status: 'active', hasDateOfBirth: true };
  }
}
