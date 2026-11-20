/**
 * OTP limits approved for launch (ADR-0018). Changing them is a product decision: update the ADR.
 */
export const OTP_LIMITS = {
  /** How long a code stays valid. */
  codeTtlSeconds: 5 * 60,
  /** Tries allowed on one code before it stops working. */
  attemptsPerCode: 5,
  /** Minimum wait between two codes for the same number. */
  resendCooldownSeconds: 60,
  perPhone: [
    { name: 'phone-15m', limit: 3, windowSeconds: 15 * 60 },
    { name: 'phone-day', limit: 10, windowSeconds: 24 * 60 * 60 },
  ],
  perIp: { name: 'ip-hour', limit: 20, windowSeconds: 60 * 60 },
  perDevice: { name: 'device-hour', limit: 10, windowSeconds: 60 * 60 },
  /** Failed tries on a number, across all its codes, that trigger the lockout. */
  lockout: { failures: 10, failureWindowSeconds: 24 * 60 * 60, lockSeconds: 60 * 60 },
} as const;

export interface WindowLimit {
  name: string;
  limit: number;
  windowSeconds: number;
}
