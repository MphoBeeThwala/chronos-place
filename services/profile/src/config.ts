import { postgresUrl } from '@chronos/config';
import { z } from 'zod';

/** The profile service's own settings, merged with the kit's (ADR-0023). */
export const profileConfig = {
  DATABASE_URL: postgresUrl,
  /** host:port of the identity service, for members' ages and verified badges (ADR-0023 f). */
  IDENTITY_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50052'),
};
