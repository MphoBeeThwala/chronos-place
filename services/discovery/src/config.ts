import { redisUrl } from '@chronos/config';
import { z } from 'zod';

const address = z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/);

/** The discovery service's own settings, merged with the kit's (ADR-0026). */
export const discoveryConfig = {
  /** Feed lists: account ids only, kept 15 minutes. */
  REDIS_URL: redisUrl,
  /** host:port of profile: FindCandidates. */
  PROFILE_GRPC_ADDRESS: address.default('127.0.0.1:50053'),
  /** host:port of matching: FilterCandidates. */
  MATCHING_GRPC_ADDRESS: address.default('127.0.0.1:50056'),
};
