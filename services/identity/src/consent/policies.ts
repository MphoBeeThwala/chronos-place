import type { ConsentType } from '../db/schema.js';

/**
 * Current policy versions (TASKS M1.2). A consent must name the current version of its policy.
 * When a policy text changes, add the new version here; members are asked to accept it again.
 *
 * The terms, privacy policy and health-processing consent texts were approved by legal counsel on
 * 2026-11-20. The marketing and biometric verification texts are still drafts. A draft
 * biometric text keeps a real liveness vendor from being switched on outside development
 * (ADR-0022): counsel must approve it first.
 */
export const CURRENT_POLICIES: Readonly<Record<ConsentType, string>> = {
  terms: 'terms-2026-11-20',
  privacy: 'privacy-2026-11-20',
  health_processing: 'health-processing-2026-11-20',
  marketing: 'marketing-2026-11-draft',
  biometric_verification: 'biometric-verification-2026-11-draft',
};

/** True while a policy text has not been approved by counsel. */
export const isDraftPolicy = (type: ConsentType): boolean =>
  CURRENT_POLICIES[type].endsWith('-draft');

/** Consents a member must give before the date-of-birth step and activation (ADR-0018). */
export const REQUIRED_FOR_ACTIVATION: readonly ConsentType[] = ['terms', 'privacy'];

/** Withdrawing either starts account deletion (sessions end now; erasure completes with M1.8). */
export const WITHDRAWAL_ENDS_ACCOUNT: readonly ConsentType[] = ['terms', 'privacy'];
