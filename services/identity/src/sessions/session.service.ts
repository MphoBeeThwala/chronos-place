import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import type { AccountStatus } from '../db/schema.js';
import type { KeyedHasher } from '../otp/keyed-hash.js';
import { type AccessTokenSigner, issueAccessToken } from './access-token.js';
import type { RevokeReason, SessionStore } from './session-store.js';

export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;
const REFRESH_FORMAT = /^[A-Za-z0-9_-]{43}$/;

const SESSION_NOT_ACCEPTED = 'Session not accepted. Sign in again.';

export interface SessionTokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface RefreshResult {
  accountId: string;
  tokens: SessionTokens;
}

export interface SessionServiceDeps {
  sessions: SessionStore;
  signer: AccessTokenSigner;
  /** Hashes device ids (the same keyed hasher as the OTP limits, purpose "device"). */
  deviceHasher: KeyedHasher;
  /** Current status of an account, or undefined if it is gone. */
  accountStatus: (accountId: string) => Promise<AccountStatus | undefined>;
  /** Statuses allowed to hold a session. */
  allowedStatuses: readonly AccountStatus[];
  logger: Logger;
  now?: () => Date;
}

/** SHA-256 of a refresh token. The token has 256 bits of entropy, so no key is needed. */
export const hashRefreshToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

/**
 * Sessions and refresh-token rotation (ADR-0018). Each refresh token works once. Presenting one
 * that was already exchanged, or from another device, is treated as theft: the whole session is
 * revoked, so both the thief's and the member's copies stop working.
 */
export class SessionService {
  readonly #d: Required<SessionServiceDeps>;

  constructor(deps: SessionServiceDeps) {
    this.#d = { now: () => new Date(), ...deps };
  }

  async open(accountId: string, deviceId: string): Promise<SessionTokens> {
    const now = this.#d.now();
    const sessionId = randomUUID();
    const refresh = this.#newRefreshToken(now);
    await this.#d.sessions.create(
      {
        id: sessionId,
        accountId,
        deviceHash: this.#d.deviceHasher.hash('device', deviceId),
        expiresAt: refresh.expiresAt,
      },
      refresh.record,
    );
    this.#d.logger.info({ accountId, sessionId }, 'session opened');
    return this.#tokens(accountId, sessionId, refresh, now);
  }

  async refresh(refreshToken: string, deviceId: string): Promise<RefreshResult> {
    if (!REFRESH_FORMAT.test(refreshToken)) throw this.#rejected();
    const now = this.#d.now();
    const found = await this.#d.sessions.findToken(hashRefreshToken(refreshToken));
    if (!found) throw this.#rejected();

    const { sessionId, accountId } = found;
    if (found.revokedAt !== null || found.sessionExpiresAt <= now || found.tokenExpiresAt <= now) {
      throw this.#rejected();
    }
    if (!this.#d.deviceHasher.hash('device', deviceId).equals(found.deviceHash)) {
      await this.#revoke(sessionId, 'device_mismatch', now);
      throw this.#rejected();
    }
    if (found.usedAt !== null || !(await this.#d.sessions.markUsed(found.tokenId, now))) {
      await this.#revoke(sessionId, 'refresh_reuse', now);
      throw this.#rejected();
    }
    const status = await this.#d.accountStatus(accountId);
    if (status === undefined || !this.#d.allowedStatuses.includes(status)) {
      await this.#revoke(sessionId, 'account_unavailable', now);
      throw this.#rejected();
    }

    const refresh = this.#newRefreshToken(now);
    await this.#d.sessions.rotate(sessionId, refresh.record, now);
    return { accountId, tokens: await this.#tokens(accountId, sessionId, refresh, now) };
  }

  /** Sign out of one session. Only the session's own account can end it. Idempotent. */
  async revoke(sessionId: string, accountId: string): Promise<void> {
    await this.#d.sessions.revoke(sessionId, 'sign_out', this.#d.now(), accountId);
  }

  /** Sign out everywhere. Idempotent. */
  async revokeAll(accountId: string, reason: RevokeReason = 'sign_out_all'): Promise<void> {
    await this.#d.sessions.revokeAll(accountId, reason, this.#d.now());
    this.#d.logger.info({ accountId, reason }, 'all sessions revoked');
  }

  async #revoke(sessionId: string, reason: RevokeReason, now: Date): Promise<void> {
    await this.#d.sessions.revoke(sessionId, reason, now);
    this.#d.logger.warn({ sessionId, reason }, 'session revoked');
  }

  #rejected(): DomainError {
    return new DomainError('unauthenticated', SESSION_NOT_ACCEPTED);
  }

  #newRefreshToken(now: Date) {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    return {
      token,
      expiresAt,
      record: { id: randomUUID(), tokenHash: hashRefreshToken(token), expiresAt },
    };
  }

  async #tokens(
    accountId: string,
    sessionId: string,
    refresh: { token: string; expiresAt: Date },
    now: Date,
  ): Promise<SessionTokens> {
    const access = await issueAccessToken(this.#d.signer, { accountId, sessionId }, now);
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }
}
