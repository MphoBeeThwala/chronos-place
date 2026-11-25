import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the client API schema (SDL), for the gateway to load. Resolved through the
 * package's own export, so it is correct from the source and from the built package alike.
 */
export const schemaPath = fileURLToPath(
  import.meta.resolve('@chronos/contracts/graphql/schema.graphql'),
);

/**
 * Mutations callable without a session. Everything else requires authentication
 * (M1.3: "unauthenticated access blocked except OTP mutations").
 */
export const PUBLIC_MUTATIONS = ['requestOtp', 'verifyOtp', 'refreshSession'] as const;

/**
 * Root fields a signed-in member may use before onboarding is finished (status PENDING_ONBOARDING):
 * the onboarding steps themselves (ADR-0020: consents, then date of birth) and session handling.
 */
export const ONBOARDING_FIELDS = [
  'account',
  'consents',
  'currentPolicies',
  'recordConsent',
  'setDateOfBirth',
  'signOut',
  ...PUBLIC_MUTATIONS,
] as const;

/**
 * Root fields that need a passed selfie liveness check (ADR-0022, M1.4 AC: messaging blocked until
 * verified). Messaging fields join this list when they are added to the schema (M4); the gateway
 * refuses them with VERIFICATION_REQUIRED until the account is verified.
 */
export const VERIFIED_FIELDS: readonly string[] = [];
