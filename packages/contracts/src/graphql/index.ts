import path from 'node:path';

/** Absolute path to the client API schema (SDL), for the gateway to load. */
export const schemaPath = path.resolve(import.meta.dirname, '../../graphql/schema.graphql');

/**
 * Mutations callable without a session. Everything else requires authentication
 * (M1.3: "unauthenticated access blocked except OTP mutations").
 */
export const PUBLIC_MUTATIONS = ['requestOtp', 'verifyOtp', 'refreshSession'] as const;
