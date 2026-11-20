import { fileURLToPath } from 'node:url';

/** The identity contract, shipped in @chronos/contracts (contracts first). */
export const IDENTITY_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/identity/v1/identity.proto'),
);
export const IDENTITY_PACKAGE = 'chronos.identity.v1';
