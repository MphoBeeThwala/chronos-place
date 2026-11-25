import { postgresUrl } from '@chronos/config';

/** The profile service's own settings, merged with the kit's (ADR-0023). */
export const profileConfig = {
  DATABASE_URL: postgresUrl,
};
