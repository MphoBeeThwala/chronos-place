import { VerificationFailure, VerificationStatus } from '@chronos/contracts/identity';

/** chronos.identity.v1.Verification as proto-loader returns it (enums as numbers). */
export interface WireVerification {
  status: number;
  failure: number;
  attemptsRemaining: number;
  reviewAvailable: boolean;
}

const STATUS: Record<number, string> = {
  [VerificationStatus.VERIFICATION_STATUS_UNVERIFIED]: 'UNVERIFIED',
  [VerificationStatus.VERIFICATION_STATUS_PENDING]: 'PENDING',
  [VerificationStatus.VERIFICATION_STATUS_VERIFIED]: 'VERIFIED',
  [VerificationStatus.VERIFICATION_STATUS_FAILED]: 'FAILED',
  [VerificationStatus.VERIFICATION_STATUS_IN_REVIEW]: 'IN_REVIEW',
};

const FAILURE: Record<number, string> = {
  [VerificationFailure.VERIFICATION_FAILURE_POOR_QUALITY]: 'POOR_QUALITY',
  [VerificationFailure.VERIFICATION_FAILURE_NOT_CONFIRMED]: 'NOT_CONFIRMED',
  [VerificationFailure.VERIFICATION_FAILURE_UNAVAILABLE]: 'UNAVAILABLE',
};

/** The client shape (GraphQL `Verification`), also returned by the capture upload route. */
export interface VerificationView {
  status: string;
  failure: string | null;
  attemptsRemaining: number;
  reviewAvailable: boolean;
}

export const verificationView = (v: WireVerification): VerificationView => ({
  status: STATUS[v.status] ?? 'UNVERIFIED',
  failure: FAILURE[v.failure] ?? null,
  attemptsRemaining: v.attemptsRemaining,
  reviewAvailable: v.reviewAvailable,
});
