import { fileURLToPath } from 'node:url';

export const IDENTITY_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/identity/v1/identity.proto'),
);
