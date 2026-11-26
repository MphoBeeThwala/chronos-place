import { postgresUrl } from '@chronos/config';

/** The Disclosure Service's own settings, merged with the kit's. */
export const disclosureConfig = {
  /**
   * The Health Vault database, connecting as (a login in) the `disclosure_service` role. Locally
   * the vault listens on 127.0.0.1:5433 only (`pnpm dev:infra`).
   */
  VAULT_DATABASE_URL: postgresUrl,
};
