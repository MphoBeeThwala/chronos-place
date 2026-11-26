import type { AllowList } from '@chronos/service-kit';

/**
 * Who may call each identity method (M2.5), identified by mTLS certificate. Anything not listed is
 * refused. Kept in step with the contract's `Caller` comments by test/allow-list.test.ts.
 */
export const IDENTITY_ALLOW_LIST: AllowList = {
  service: 'chronos.identity.v1.IdentityService',
  methods: {
    RequestOtp: ['gateway'],
    VerifyOtp: ['gateway'],
    RefreshSession: ['gateway'],
    RevokeSession: ['gateway'],
    RevokeAllSessions: ['gateway'],
    SetDateOfBirth: ['gateway'],
    GetAccount: ['gateway'],
    GetSigningKeys: ['gateway'],
    RecordConsent: ['gateway'],
    ListConsents: ['gateway'],
    GetCurrentPolicies: ['gateway'],
    SubmitLiveness: ['gateway'],
    GetVerification: ['gateway'],
    RequestVerificationReview: ['gateway'],
    GetMemberFacts: ['profile', 'disclosure-service'],
    RequestDeletionCode: ['gateway'],
    DeleteAccount: ['gateway'],
    ExportAccount: ['gateway'],
  },
};
