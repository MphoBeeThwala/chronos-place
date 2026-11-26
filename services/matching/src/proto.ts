import { fileURLToPath } from 'node:url';

export const MATCHING_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/matching/v1/matching.proto'),
);
export const MATCHING_PACKAGE = 'chronos.matching.v1';
