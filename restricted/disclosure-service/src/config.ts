import { httpUrl, postgresUrl } from '@chronos/config';
import { z } from 'zod';

/** The Disclosure Service's own settings, merged with the kit's. */
export const disclosureConfig = {
  /**
   * The Health Vault database, connecting as (a login in) the `disclosure_service` role. Locally
   * the vault listens on 127.0.0.1:5433 only (`pnpm dev:infra`).
   */
  VAULT_DATABASE_URL: postgresUrl,
  /** Symmetric KMS key that wraps each member's vault data key (TECHNICAL_SPEC 4.4). */
  VAULT_DATA_KEY_ID: z.string().min(1),
  /** A local KMS stand-in in development; unset in AWS. */
  KMS_ENDPOINT: httpUrl.optional(),
  /**
   * host:port of matching, for blocks and matches (M3.1). Unset: every view or share by another
   * member is refused (fail closed).
   */
  MATCHING_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .optional(),
  /** Bucket of the erasure ledger, outside the vault and its backups (ADR-0014). */
  VAULT_LEDGER_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  /** S3-compatible endpoint for the ledger; SeaweedFS locally, unset in AWS. */
  S3_ENDPOINT: httpUrl.optional(),
  /** host:port of identity, for whether members are active and verified (TECHNICAL_SPEC 4.2). */
  IDENTITY_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50052'),
};
