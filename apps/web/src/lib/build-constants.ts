/**
 * Values Next.js inlines at build time (next.config.ts `env`, and NODE_ENV). They are fixed in the
 * bundle, not read at runtime, and the edge middleware that needs them cannot run
 * @chronos/config (it reads secret files from disk). next.config.ts validates STORAGE_ORIGIN.
 */
/* eslint-disable no-restricted-syntax -- build-time constants, inlined by Next.js (see above) */
export const STORAGE_ORIGIN: string | undefined =
  process.env['CHRONOS_STORAGE_ORIGIN'] || undefined;
export const DEVELOPMENT: boolean = process.env.NODE_ENV === 'development';
/* eslint-enable no-restricted-syntax -- only the two constants above */
