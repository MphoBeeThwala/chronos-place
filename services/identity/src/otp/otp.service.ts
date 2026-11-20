import { randomUUID } from 'node:crypto';
import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import type { ChallengeStore } from './challenge-store.js';
import { type CodeHasher, generateCode, isWellFormedCode } from './code.js';
import type { KeyedHasher } from './keyed-hash.js';
import { OTP_LIMITS, type WindowLimit } from './limits.js';
import type { OtpSender } from './otp-sender.js';
import { parseSouthAfricanMobile } from './phone.js';
import type { RateLimitStore } from './rate-limiter.js';

/** KMS encryption-context purpose for identity's per-account keys (ADR-0018). */
export const IDENTITY_KEY_PURPOSE = 'identity';
/** AAD field name for the sealed phone number. */
export const PHONE_FIELD = 'phone';

export interface ClientContext {
  deviceId: string;
  ip: string;
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: Date;
  retryAfterSeconds: number;
}

/** What a successful check hands to account creation and sign-in (part 3). */
export interface VerifiedPhone {
  phoneLookup: Buffer;
  /** The id the number was sealed under; becomes the account id if this sign-in creates one. */
  prospectiveAccountId: string;
  phoneCiphertext: Buffer;
  phoneNonce: Buffer;
}

/** Thrown when a limit or lockout applies. The message is generic; the wait is for the gateway. */
export class OtpRateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('resource_exhausted', 'Too many attempts. Try again later.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Fixed messages. "Code not accepted" covers wrong, expired, used and unknown challenges alike, so
// a caller learns nothing about which it was, or whether the number has an account.
const INVALID_NUMBER = 'Enter a South African mobile number.';
const CODE_NOT_ACCEPTED = 'Code not accepted.';
const SEND_FAILED = 'The code could not be sent. Try again.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OtpServiceDeps {
  challenges: ChallengeStore;
  limits: RateLimitStore;
  sender: OtpSender;
  keyring: SubjectKeyring;
  lookupHasher: KeyedHasher;
  codeHasher: CodeHasher;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
}

export class OtpService {
  readonly #d: Required<OtpServiceDeps>;

  constructor(deps: OtpServiceDeps) {
    this.#d = {
      now: () => new Date(),
      newId: randomUUID,
      newCode: generateCode,
      ...deps,
    };
  }

  async requestOtp(phoneInput: string, client: ClientContext): Promise<OtpChallenge> {
    const phone = parseSouthAfricanMobile(phoneInput);
    if (phone === undefined) throw new DomainError('invalid_argument', INVALID_NUMBER);

    const phoneKey = this.#d.lookupHasher.hash('phone', phone);
    const tag = phoneKey.toString('hex');

    const locked = await this.#d.limits.ttl(`lock:${tag}`);
    if (locked > 0) throw new OtpRateLimitedError(locked);
    const cooldown = await this.#d.limits.ttl(`cooldown:${tag}`);
    if (cooldown > 0) throw new OtpRateLimitedError(cooldown);

    // Every request counts against every window, including rejected ones.
    const windows: [string, WindowLimit][] = [
      [`ip:${this.#d.lookupHasher.hash('ip', client.ip).toString('hex')}`, OTP_LIMITS.perIp],
      [
        `device:${this.#d.lookupHasher.hash('device', client.deviceId).toString('hex')}`,
        OTP_LIMITS.perDevice,
      ],
      ...OTP_LIMITS.perPhone.map((limit): [string, WindowLimit] => [`phone:${tag}`, limit]),
    ];
    let wait = 0;
    for (const [key, limit] of windows) {
      const { count, resetSeconds } = await this.#d.limits.hit(
        `${key}:${limit.name}`,
        limit.windowSeconds,
      );
      if (count > limit.limit) wait = Math.max(wait, resetSeconds);
    }
    if (wait > 0) {
      this.#d.logger.info({ reason: 'rate_limited' }, 'otp request refused');
      throw new OtpRateLimitedError(wait);
    }

    const challengeId = this.#d.newId();
    const prospectiveAccountId = this.#d.newId();
    const code = this.#d.newCode();
    const sealed = await this.#d.keyring.encrypt(prospectiveAccountId, PHONE_FIELD, phone);
    const expiresAt = new Date(this.#d.now().getTime() + OTP_LIMITS.codeTtlSeconds * 1000);

    await this.#d.challenges.insert({
      id: challengeId,
      phoneLookup: phoneKey,
      prospectiveAccountId,
      phoneCiphertext: Buffer.from(sealed.ciphertext),
      phoneNonce: Buffer.from(sealed.nonce),
      codeHash: this.#d.codeHasher.hash(challengeId, code),
      expiresAt,
    });
    await this.#d.limits.set(`cooldown:${tag}`, OTP_LIMITS.resendCooldownSeconds);

    try {
      await this.#d.sender.send(phone, code);
    } catch (err) {
      this.#d.logger.error({ err }, 'otp delivery failed');
      throw new DomainError('unavailable', SEND_FAILED);
    }
    this.#d.logger.info({ challengeId }, 'otp sent');
    return { challengeId, expiresAt, retryAfterSeconds: OTP_LIMITS.resendCooldownSeconds };
  }

  async verifyOtp(challengeId: string, code: string): Promise<VerifiedPhone> {
    if (!UUID.test(challengeId) || !isWellFormedCode(code)) {
      throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    }
    const now = this.#d.now();
    const open = await this.#d.challenges.findOpen(challengeId, now);
    if (!open) throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);

    const tag = open.phoneLookup.toString('hex');
    const locked = await this.#d.limits.ttl(`lock:${tag}`);
    if (locked > 0) throw new OtpRateLimitedError(locked);

    // The try is counted before the code is compared, so parallel guesses cannot beat the limit.
    const attempt = await this.#d.challenges.recordAttempt(
      challengeId,
      OTP_LIMITS.attemptsPerCode,
      now,
    );
    if (!attempt) throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);

    if (!this.#d.codeHasher.matches(challengeId, code, attempt.codeHash)) {
      const { lockout } = OTP_LIMITS;
      const { count } = await this.#d.limits.hit(`fail:${tag}`, lockout.failureWindowSeconds);
      if (count >= lockout.failures) {
        await this.#d.limits.set(`lock:${tag}`, lockout.lockSeconds);
        await this.#d.limits.delete(`fail:${tag}`);
        this.#d.logger.warn({ challengeId }, 'otp lockout applied');
      }
      throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    }

    if (!(await this.#d.challenges.consume(challengeId, now))) {
      throw new DomainError('unauthenticated', CODE_NOT_ACCEPTED);
    }
    await this.#d.limits.delete(`fail:${tag}`);
    this.#d.logger.info({ challengeId }, 'otp verified');
    return {
      phoneLookup: attempt.phoneLookup,
      prospectiveAccountId: attempt.prospectiveAccountId,
      phoneCiphertext: attempt.phoneCiphertext,
      phoneNonce: attempt.phoneNonce,
    };
  }
}
