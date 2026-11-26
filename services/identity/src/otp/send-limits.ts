import type { Logger } from '@chronos/logger';
import type { KeyedHasher } from './keyed-hash.js';
import { OTP_LIMITS, type WindowLimit } from './limits.js';
import { DomainError } from '@chronos/service-kit';
import type { ClientContext } from './otp.service.js';
import type { RateLimitStore } from './rate-limiter.js';

/** Thrown when a limit or lockout applies. The message is generic; the wait is for the gateway. */
export class OtpRateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('resource_exhausted', 'Too many attempts. Try again later.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Limits shared by every kind of code, keyed on the number's lookup hash: sign-in codes and
 * account-deletion codes (ADR-0025) draw on the same windows, cooldown and lockout, so asking for
 * deletion codes is no way around the sign-in limits.
 */
export interface CodeLimitsDeps {
  limits: RateLimitStore;
  lookupHasher: KeyedHasher;
  logger: Logger;
}

/** Throws OtpRateLimitedError when a lockout, cooldown or send window applies. Counts the try. */
export async function enforceSendLimits(
  d: CodeLimitsDeps,
  tag: string,
  client: ClientContext,
): Promise<void> {
  const locked = await d.limits.ttl(`lock:${tag}`);
  if (locked > 0) throw new OtpRateLimitedError(locked);
  const cooldown = await d.limits.ttl(`cooldown:${tag}`);
  if (cooldown > 0) throw new OtpRateLimitedError(cooldown);

  // Every request counts against every window, including rejected ones.
  const windows: [string, WindowLimit][] = [
    [`ip:${d.lookupHasher.hash('ip', client.ip).toString('hex')}`, OTP_LIMITS.perIp],
    [
      `device:${d.lookupHasher.hash('device', client.deviceId).toString('hex')}`,
      OTP_LIMITS.perDevice,
    ],
    ...OTP_LIMITS.perPhone.map((limit): [string, WindowLimit] => [`phone:${tag}`, limit]),
  ];
  let wait = 0;
  for (const [key, limit] of windows) {
    const { count, resetSeconds } = await d.limits.hit(`${key}:${limit.name}`, limit.windowSeconds);
    if (count > limit.limit) wait = Math.max(wait, resetSeconds);
  }
  if (wait > 0) {
    d.logger.info({ reason: 'rate_limited' }, 'otp request refused');
    throw new OtpRateLimitedError(wait);
  }
}

/** Starts the resend cooldown after a code is sent. */
export async function startCooldown(d: CodeLimitsDeps, tag: string): Promise<void> {
  await d.limits.set(`cooldown:${tag}`, OTP_LIMITS.resendCooldownSeconds);
}

/** Throws OtpRateLimitedError while the number is locked out after too many wrong codes. */
export async function enforceNotLocked(d: CodeLimitsDeps, tag: string): Promise<void> {
  const locked = await d.limits.ttl(`lock:${tag}`);
  if (locked > 0) throw new OtpRateLimitedError(locked);
}

/** Counts a wrong code; enough of them lock the number out. */
export async function recordWrongCode(
  d: CodeLimitsDeps,
  tag: string,
  challengeId: string,
): Promise<void> {
  const { lockout } = OTP_LIMITS;
  const { count } = await d.limits.hit(`fail:${tag}`, lockout.failureWindowSeconds);
  if (count >= lockout.failures) {
    await d.limits.set(`lock:${tag}`, lockout.lockSeconds);
    await d.limits.delete(`fail:${tag}`);
    d.logger.warn({ challengeId }, 'otp lockout applied');
  }
}

/** Clears the wrong-code count after a right one. */
export async function clearWrongCodes(d: CodeLimitsDeps, tag: string): Promise<void> {
  await d.limits.delete(`fail:${tag}`);
}
