import {
  AccountStatus,
  ConsentType,
  VerificationFailure,
  VerificationStatus,
} from '@chronos/contracts/identity';
import { DomainError } from '@chronos/service-kit';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { z } from 'zod';
import type { AccountRecord } from './accounts/account-store.js';
import type { ConsentType as StoredConsent, AccountStatus as StoredStatus } from './db/schema.js';
import type { IdentityRuntime } from './runtime.js';
import type { SessionTokens } from './sessions/session.service.js';
import { MAX_LIVENESS_FRAMES } from './verification/capture.js';
import type { VerificationView } from './verification/verification.service.js';

export const IDENTITY_RUNTIME = Symbol('IDENTITY_RUNTIME');

const SERVICE = 'IdentityService';
const INVALID_REQUEST = 'Invalid request.';

// Validated at the edge (CLAUDE.md coding standards). Field names are the proto-loader camelCase.
const clientContext = z.object({
  deviceId: z.string().min(1).max(128),
  ip: z.string().min(1).max(64),
});
const uuid = z.uuid();
const schemas = {
  requestOtp: z.object({ phoneE164: z.string().min(1).max(32), client: clientContext }),
  verifyOtp: z.object({
    challengeId: z.string().max(64),
    code: z.string().max(16),
    client: clientContext,
  }),
  refresh: z.object({ refreshToken: z.string().max(128), client: clientContext }),
  revoke: z.object({ sessionId: uuid, accountId: uuid }),
  account: z.object({ accountId: uuid }),
  deletionCode: z.object({ accountId: uuid, client: clientContext }),
  deleteAccount: z.object({
    accountId: uuid,
    challengeId: z.string().max(64),
    code: z.string().max(16),
  }),
  memberFacts: z.object({ accountIds: z.array(uuid).max(100).default([]) }),
  consent: z.object({
    accountId: uuid,
    type: z.number().int(),
    policyVersion: z.string().min(1).max(64),
    granted: z.boolean(),
  }),
  liveness: z.object({
    accountId: uuid,
    capture: z.object({
      selfieJpeg: z.instanceof(Buffer),
      livenessFramesJpeg: z.array(z.instanceof(Buffer)).max(MAX_LIVENESS_FRAMES).default([]),
    }),
  }),
  dateOfBirth: z.object({
    accountId: uuid,
    dateOfBirth: z.object({
      year: z.number().int(),
      month: z.number().int(),
      day: z.number().int(),
    }),
  }),
};

function parse<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const result = schema.safeParse(request);
  if (!result.success) throw new DomainError('invalid_argument', INVALID_REQUEST);
  return result.data;
}

const STATUS: Record<StoredStatus, AccountStatus> = {
  pending_onboarding: AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING,
  active: AccountStatus.ACCOUNT_STATUS_ACTIVE,
  ineligible: AccountStatus.ACCOUNT_STATUS_INELIGIBLE,
  suspended: AccountStatus.ACCOUNT_STATUS_SUSPENDED,
  pending_erasure: AccountStatus.ACCOUNT_STATUS_PENDING_ERASURE,
  erased: AccountStatus.ACCOUNT_STATUS_ERASED,
};

const CONSENT: Record<StoredConsent, ConsentType> = {
  terms: ConsentType.CONSENT_TYPE_TERMS,
  privacy: ConsentType.CONSENT_TYPE_PRIVACY,
  health_processing: ConsentType.CONSENT_TYPE_HEALTH_PROCESSING,
  marketing: ConsentType.CONSENT_TYPE_MARKETING,
  biometric_verification: ConsentType.CONSENT_TYPE_BIOMETRIC_VERIFICATION,
};
const CONSENT_FROM_WIRE = new Map<number, StoredConsent>(
  (Object.entries(CONSENT) as [StoredConsent, ConsentType][]).map(([k, v]) => [v, k]),
);

const VERIFICATION_STATUS: Record<VerificationView['status'], VerificationStatus> = {
  unverified: VerificationStatus.VERIFICATION_STATUS_UNVERIFIED,
  pending: VerificationStatus.VERIFICATION_STATUS_PENDING,
  verified: VerificationStatus.VERIFICATION_STATUS_VERIFIED,
  failed: VerificationStatus.VERIFICATION_STATUS_FAILED,
  in_review: VerificationStatus.VERIFICATION_STATUS_IN_REVIEW,
};

const VERIFICATION_FAILURE: Record<
  NonNullable<VerificationView['failure']>,
  VerificationFailure
> = {
  poor_quality: VerificationFailure.VERIFICATION_FAILURE_POOR_QUALITY,
  not_confirmed: VerificationFailure.VERIFICATION_FAILURE_NOT_CONFIRMED,
  unavailable: VerificationFailure.VERIFICATION_FAILURE_UNAVAILABLE,
};

const verification = (view: VerificationView) => ({
  verification: {
    status: VERIFICATION_STATUS[view.status],
    failure: view.failure
      ? VERIFICATION_FAILURE[view.failure]
      : VerificationFailure.VERIFICATION_FAILURE_UNSPECIFIED,
    attemptsRemaining: view.attemptsRemaining,
    reviewAvailable: view.reviewAvailable,
  },
});

/** google.protobuf.Timestamp fields are passed as Date; the transport encodes them. */
const timestamp = (date: Date): Date => date;

const account = (record: AccountRecord) => ({
  accountId: record.id,
  status: STATUS[record.status],
  verified: record.verified,
});

const tokens = (t: SessionTokens) => ({
  accessToken: t.accessToken,
  accessExpiresAt: timestamp(t.accessExpiresAt),
  refreshToken: t.refreshToken,
  refreshExpiresAt: timestamp(t.refreshExpiresAt),
});

/** chronos.identity.v1.IdentityService. Only the gateway calls it (allow-list arrives with M2.5). */
@Controller()
export class IdentityController {
  readonly #runtime: IdentityRuntime;

  constructor(@Inject(IDENTITY_RUNTIME) runtime: IdentityRuntime) {
    this.#runtime = runtime;
  }

  @GrpcMethod(SERVICE, 'RequestOtp')
  async requestOtp(request: unknown) {
    const { phoneE164, client } = parse(schemas.requestOtp, request);
    const challenge = await this.#runtime.otp.requestOtp(phoneE164, client);
    return {
      challengeId: challenge.challengeId,
      expiresAt: timestamp(challenge.expiresAt),
      retryAfterSeconds: challenge.retryAfterSeconds,
    };
  }

  @GrpcMethod(SERVICE, 'VerifyOtp')
  async verifyOtp(request: unknown) {
    const { challengeId, code, client } = parse(schemas.verifyOtp, request);
    const verified = await this.#runtime.otp.verifyOtp(challengeId, code);
    const signIn = await this.#runtime.accounts.signIn(verified);
    const session = await this.#runtime.sessions.open(signIn.account.id, client.deviceId);
    return { account: account(signIn.account), tokens: tokens(session), created: signIn.created };
  }

  @GrpcMethod(SERVICE, 'RefreshSession')
  async refreshSession(request: unknown) {
    const { refreshToken, client } = parse(schemas.refresh, request);
    const refreshed = await this.#runtime.sessions.refresh(refreshToken, client.deviceId);
    const record = await this.#runtime.accounts.get(refreshed.accountId);
    return { account: account(record), tokens: tokens(refreshed.tokens) };
  }

  @GrpcMethod(SERVICE, 'RevokeSession')
  async revokeSession(request: unknown) {
    const { sessionId, accountId } = parse(schemas.revoke, request);
    await this.#runtime.sessions.revoke(sessionId, accountId);
    return {};
  }

  @GrpcMethod(SERVICE, 'RevokeAllSessions')
  async revokeAllSessions(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    await this.#runtime.sessions.revokeAll(accountId);
    return {};
  }

  @GrpcMethod(SERVICE, 'SetDateOfBirth')
  async setDateOfBirth(request: unknown) {
    const { accountId, dateOfBirth } = parse(schemas.dateOfBirth, request);
    return {
      account: account(await this.#runtime.accounts.setDateOfBirth(accountId, dateOfBirth)),
    };
  }

  @GrpcMethod(SERVICE, 'GetAccount')
  async getAccount(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    return { account: account(await this.#runtime.accounts.get(accountId)) };
  }

  @GrpcMethod(SERVICE, 'GetSigningKeys')
  async getSigningKeys() {
    const { signer } = this.#runtime;
    return {
      keys: [{ kid: await signer.keyId(), jwkJson: JSON.stringify(await signer.publicJwk()) }],
    };
  }

  @GrpcMethod(SERVICE, 'RecordConsent')
  async recordConsent(request: unknown) {
    const { accountId, type, policyVersion, granted } = parse(schemas.consent, request);
    const consentType = CONSENT_FROM_WIRE.get(type);
    if (consentType === undefined) throw new DomainError('invalid_argument', INVALID_REQUEST);
    const result = await this.#runtime.consents.record(
      accountId,
      consentType,
      policyVersion,
      granted,
    );
    return { account: account(result.account) };
  }

  @GrpcMethod(SERVICE, 'ListConsents')
  async listConsents(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    const records = await this.#runtime.consents.history(accountId);
    return {
      records: records.map((r) => ({
        type: CONSENT[r.type],
        policyVersion: r.policyVersion,
        granted: r.granted,
        recordedAt: timestamp(r.recordedAt),
      })),
    };
  }

  @GrpcMethod(SERVICE, 'GetCurrentPolicies')
  getCurrentPolicies() {
    return {
      policies: this.#runtime.consents
        .currentPolicies()
        .map((p) => ({ type: CONSENT[p.type], version: p.version })),
    };
  }

  @GrpcMethod(SERVICE, 'SubmitLiveness')
  async submitLiveness(request: unknown) {
    const { accountId, capture } = parse(schemas.liveness, request);
    return verification(
      await this.#runtime.verification.submit(accountId, {
        selfie: capture.selfieJpeg,
        frames: capture.livenessFramesJpeg,
      }),
    );
  }

  @GrpcMethod(SERVICE, 'GetVerification')
  async getVerification(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    return verification(await this.#runtime.verification.get(accountId));
  }

  @GrpcMethod(SERVICE, 'RequestVerificationReview')
  async requestVerificationReview(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    return verification(await this.#runtime.verification.requestReview(accountId));
  }

  @GrpcMethod(SERVICE, 'GetMemberFacts')
  async getMemberFacts(request: unknown) {
    const { accountIds } = parse(schemas.memberFacts, request);
    return { members: await this.#runtime.accounts.memberFacts(accountIds) };
  }

  // Account deletion (TASKS M1.8, ADR-0025).
  @GrpcMethod(SERVICE, 'RequestDeletionCode')
  async requestDeletionCode(request: unknown) {
    const { accountId, client } = parse(schemas.deletionCode, request);
    const challenge = await this.#runtime.deletion.requestCode(accountId, client);
    return {
      challengeId: challenge.challengeId,
      expiresAt: timestamp(challenge.expiresAt),
      retryAfterSeconds: challenge.retryAfterSeconds,
    };
  }

  @GrpcMethod(SERVICE, 'DeleteAccount')
  async deleteAccount(request: unknown) {
    const { accountId, challengeId, code } = parse(schemas.deleteAccount, request);
    await this.#runtime.deletion.deleteAccount(accountId, challengeId, code);
    return { account: account(await this.#runtime.accounts.get(accountId)) };
  }
}
