import type { ConsentType } from '../db/schema.js';

/**
 * Current policy versions (TASKS M1.2). A consent must name the current version of its policy.
 * When a policy text changes, add the new version here; members are asked to accept it again.
 *
 * Terms and the health-processing consent texts were approved by legal counsel on 2026-11-20.
 * The privacy policy and marketing texts are still drafts.
 */
export const CURRENT_POLICIES: Readonly<Record<ConsentType, string>> = {
  terms: 'terms-2026-11-20',
  privacy: 'privacy-2026-11-draft',
  health_processing: 'health-processing-2026-11-20',
  marketing: 'marketing-2026-11-draft',
};

/** Consents a member must give before the date-of-birth step and activation (ADR-0018). */
export const REQUIRED_FOR_ACTIVATION: readonly ConsentType[] = ['terms', 'privacy'];

/** Withdrawing either starts account deletion (sessions end now; erasure completes with M1.8). */
export const WITHDRAWAL_ENDS_ACCOUNT: readonly ConsentType[] = ['terms', 'privacy'];
