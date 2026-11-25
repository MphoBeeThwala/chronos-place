import { fileURLToPath } from 'node:url';

/** The profile contract, shipped in @chronos/contracts (contracts first). */
export const PROFILE_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/profile/v1/profile.proto'),
);
export const PROFILE_PACKAGE = 'chronos.profile.v1';
