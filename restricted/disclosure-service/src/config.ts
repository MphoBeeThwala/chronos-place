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
};
