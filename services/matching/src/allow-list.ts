import type { AllowList } from '@chronos/service-kit';

/**
 * Who may call each matching method (M2.5), identified by mTLS certificate. Anything not listed is
 * refused. Kept in step with the contract's `Caller` comments by test/allow-list.test.ts.
 */
export const MATCHING_ALLOW_LIST: AllowList = {
  service: 'chronos.matching.v1.MatchingService',
  methods: {
    Like: ['gateway'],
    Pass: ['gateway'],
    Unmatch: ['gateway'],
    Block: ['gateway'],
    Unblock: ['gateway'],
    ListMatches: ['gateway'],
    ListBlocked: ['gateway'],
    GetRelationship: ['disclosure-service', 'messaging'],
    FilterVisible: ['profile', 'discovery'],
  },
};
