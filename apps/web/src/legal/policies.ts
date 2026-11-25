/**
 * The terms and privacy policy shown at /terms and /privacy (TASKS M1.7).
 *
 * The versions must match identity's CURRENT_POLICIES (services/identity/src/consent/policies.ts);
 * a test checks this. Counsel approved both texts on 2026-11-20 (ADR-0020), but the texts have
 * not been added to the repository yet. Until they are, `text` is null and the pages say so
 * plainly. Do not launch with `text: null`.
 */
export interface PolicyDocument {
  title: string;
  version: string;
  approvedOn: string;
  /** Paragraphs of the approved text, or null until it is added. */
  text: readonly string[] | null;
}

export const TERMS: PolicyDocument = {
  title: 'Terms of Service',
  version: 'terms-2026-11-20',
  approvedOn: '20 November 2026',
  text: null,
};

export const PRIVACY: PolicyDocument = {
  title: 'Privacy Policy',
  version: 'privacy-2026-11-20',
  approvedOn: '20 November 2026',
  text: null,
};
