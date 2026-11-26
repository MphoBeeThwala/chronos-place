import { fileURLToPath } from 'node:url';

/** The Disclosure contract, shipped in @chronos/contracts (contracts first, ADR-0002). */
export const DISCLOSURE_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/disclosure/v1/disclosure.proto'),
);
export const DISCLOSURE_PACKAGE = 'chronos.disclosure.v1';
