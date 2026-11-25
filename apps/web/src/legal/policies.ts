/**
 * The terms and privacy policy shown at /terms and /privacy (TASKS M1.7).
 *
 * Legal counsel (Dumisani Lukhele) approved both texts on 2026-11-26. The approved words live in
 * docs/legal/<version>.md; `pnpm --filter @chronos/web legal:gen` turns them into
 * policy-texts.generated.ts. The versions must match identity's CURRENT_POLICIES
 * (services/identity/src/consent/policies.ts); a test checks this.
 */
import type { Block } from './policy-blocks';
import { POLICY_TEXTS } from './policy-texts.generated';

export interface PolicyDocument {
  title: string;
  version: string;
  approvedOn: string;
  blocks: Block[];
}

export const TERMS: PolicyDocument = {
  title: 'Terms of Service',
  version: POLICY_TEXTS.terms.version,
  approvedOn: '26 November 2026',
  blocks: POLICY_TEXTS.terms.blocks,
};

export const PRIVACY: PolicyDocument = {
  title: 'Privacy Policy',
  version: POLICY_TEXTS.privacy.version,
  approvedOn: '26 November 2026',
  blocks: POLICY_TEXTS.privacy.blocks,
};
