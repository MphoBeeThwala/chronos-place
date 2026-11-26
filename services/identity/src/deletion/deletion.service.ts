import { randomUUID } from 'node:crypto';
import { createEvent } from '@chronos/contracts/events';
import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { type CodeHasher, generateCode, isWellFormedCode } from '../otp/code.js';
import type { KeyedHasher } from '../otp/keyed-hash.js';
import { OTP_LIMITS } from '../otp/limits.js';
import type { OtpSender } from '../otp/otp-sender.js';
import {
  type ClientContext,
  CODE_NOT_ACCEPTED,
  type OtpChallenge,
  PHONE_FIELD,
  SEND_FAILED,
  UUID,
} from '../otp/otp.service.js';
import type { RateLimitStore } from '../otp/rate-limiter.js';
import {
  clearWrongCodes,
  enforceNotLocked,
  enforceSendLimits,
  recordWrongCode,
  startCooldown,
} from '../otp/send-limits.js';
import type { RevokeReason } from '../sessions/session-store.js';
import type { DeletionStore } from './deletion-store.js';

/** Only an account a member can use may be deleted this way. */
const DELETABLE = ['pending_onboarding', 'active'] as const;
const NOT_AVAILABLE = 'This account cannot be deleted here.';

export interface DeletionServiceDeps {
  store: DeletionStore;
  limits: RateLimitStore;
  sender: OtpSender;
  keyring: SubjectKeyring;
  lookupHasher: KeyedHasher;
  codeHasher: CodeHasher;
  revokeAllSessions: (accountId: string, reason: RevokeReason) => Promise<void>;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
}

/**
 * Account deletion (ADR-0025). A fresh code to the account's own number confirms it; the code can
 * only confirm deletion. Once confirmed, deletion starts at once and cannot be undone. Codes share
 * every limit with sign-in codes, keyed on the same number.
 */
export class DeletionService {
  readonly #d: Required<DeletionServiceDeps>;

  constructor(deps: DeletionServiceDeps) {
    this.#d = { now: () => new Date(), newId: randomUUID, newCode: generateCode, ...deps };
  }

  async requestCode(accountId: string, client: ClientContext): Promise<OtpChallenge> {
    const contact = await this.#d.store.contact(accountId);
    if (
      !contact ||
      !(DELETABLE as readonly string[]).includes(contact.status) ||
      !contact.phoneLookup ||
      !contact.phoneCiphertext ||
      !contact.phoneNonce
    ) {
      throw new DomainError('failed_precondition', NOT_AVAILABLE);
    }
    const tag = contact.phoneLookup.toString('hex');
    await enforceSendLimits(this.#d, tag, client);

    const phone = String(
      await this.#d.keyring.decrypt(accountId, PHONE_FIELD, {
        ciphertext: contact.phoneCiphertext,
        nonce: contact.phoneNonce,
      }),
    );
    const challengeId = this.#d.newId();
    const code = this.#d.newCode();
    const expiresAt = new Date(this.#d.now().getTime() + OTP_LIMITS.codeTtlSeconds * 1000);
    await this.#d.store.insertChallenge({
      id: challengeId,
      accountId,
      codeHash: this.#d.codeHasher.hash(challengeId, code),
      expiresAt,
    });
    await startCooldown(this.#d, tag);
    try {
      await this.#d.sender.send(phone, code);
    } catch (err) {
      this.#d.logger.error({ err }, 'deletion code delivery failed');
      throw new DomainError('unavailable', SEND_FAILED);
    }
    this.#d.logger.info({ challengeId }, 'deletion code sent');
    return { challengeId, expiresAt, retryAfterSeconds: OTP_LIMITS.resendCooldownSeconds };
  }

  /** Checks the code, then starts erasure and ends every session. */
  async deleteAccount(accountId: string, challengeId: string, code: string): Promise<void> {
    if (!UUID.test(challengeId) || !isWellFormedCode(code)) {
      throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    }
    const contact = await this.#d.store.contact(accountId);
    if (contact?.status === 'pending_erasure') return; // Already started: nothing more to do.
    if (!contact?.phoneLookup || !(DELETABLE as readonly string[]).includes(contact.status)) {
      throw new DomainError('failed_precondition', NOT_AVAILABLE);
    }
    const tag = contact.phoneLookup.toString('hex');
    await enforceNotLocked(this.#d, tag);

    const now = this.#d.now();
    const codeHash = await this.#d.store.recordAttempt(
      challengeId,
      accountId,
      OTP_LIMITS.attemptsPerCode,
      now,
    );
    if (!codeHash) throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    if (!this.#d.codeHasher.matches(challengeId, code, codeHash)) {
      await recordWrongCode(this.#d, tag, challengeId);
      throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    }

    const event = createEvent(
      'account.erasure_requested',
      'identity',
      { accountId, requestedAt: now.toISOString() },
      { now },
    );
    const started = await this.#d.store.confirm(challengeId, {
      accountId,
      now,
      vaultRequestId: this.#d.newId(),
      events: [event],
    });
    if (!started) throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    await clearWrongCodes(this.#d, tag);
    await this.#d.revokeAllSessions(accountId, 'account_deleted');
    this.#d.logger.info({ accountId }, 'account deletion started');
  }
}
