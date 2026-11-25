import { httpUrl, postgresUrl, redisUrl, secret } from '@chronos/config';
import { z } from 'zod';

/**
 * The identity service's own settings, merged with the kit's (ADR-0018). Secrets come from the
 * environment locally and from AWS Secrets Manager when deployed (CLAUDE.md rule 11).
 */
export const identityConfig = {
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  /** LocalStack in development; unset in AWS. */
  KMS_ENDPOINT: httpUrl.optional(),
  /** Symmetric KMS key that wraps the per-account data keys. */
  IDENTITY_DATA_KEY_ID: z.string().min(1),
  /** Asymmetric KMS key (ECC_NIST_P256, SIGN_VERIFY) for access tokens. Optional only locally. */
  ACCESS_TOKEN_KEY_ID: z.string().min(1).optional(),
  /** Base64, at least 32 bytes: keyed hashes of numbers, IPs and device ids. */
  PHONE_LOOKUP_KEY: secret(32),
  /** Base64, at least 32 bytes: keyed hashes of one-time codes. */
  OTP_CODE_KEY: secret(32),
  /** Only "mailpit" exists until an SMS provider is contracted (ADR-0006). */
  OTP_SENDER: z.enum(['mailpit']).default('mailpit'),
  MAILPIT_URL: httpUrl.default('http://127.0.0.1:8025'),

  /**
   * Liveness vendor (ADR-0022). "fake" passes every capture and is development only. "smile-id"
   * needs the partner id, API key and a capture bucket. Outside development it also needs
   * counsel's approval of the biometric consent text.
   */
  LIVENESS_PROVIDER: z.enum(['fake', 'smile-id']).default('fake'),
  SMILE_ID_PARTNER_ID: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
  SMILE_ID_API_KEY: secret(16).optional(),
  SMILE_ID_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Bucket for sealed selfie captures, kept at most 30 days. */
  CAPTURE_BUCKET: z.string().min(3).optional(),
  /** SeaweedFS locally (http://127.0.0.1:8333); unset in AWS. */
  S3_ENDPOINT: httpUrl.optional(),
};

/** Environments where development stand-ins (local signing key, Mailpit) are allowed. */
export const DEVELOPMENT_ENVIRONMENTS = ['local', 'test', 'development'] as const;
