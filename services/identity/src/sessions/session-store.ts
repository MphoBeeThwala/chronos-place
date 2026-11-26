import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { refreshTokens, sessions } from '../db/schema.js';

export type RevokeReason =
  | 'sign_out'
  | 'sign_out_all'
  | 'refresh_reuse'
  | 'device_mismatch'
  | 'account_unavailable'
  | 'consent_withdrawn'
  | 'account_deleted'
  | 'ineligible';

export interface NewRefreshToken {
  id: string;
  tokenHash: Buffer;
  expiresAt: Date;
}

export interface FoundToken {
  tokenId: string;
  usedAt: Date | null;
  tokenExpiresAt: Date;
  sessionId: string;
  accountId: string;
  deviceHash: Buffer;
  sessionExpiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionStore {
  create(
    session: { id: string; accountId: string; deviceHash: Buffer; expiresAt: Date },
    token: NewRefreshToken,
  ): Promise<void>;
  findToken(tokenHash: Buffer): Promise<FoundToken | undefined>;
  /** Marks a token exchanged. False if it already was: that is reuse. */
  markUsed(tokenId: string, now: Date): Promise<boolean>;
  /** Adds the next token of a session and extends the session to it. */
  rotate(sessionId: string, token: NewRefreshToken, now: Date): Promise<void>;
  revoke(sessionId: string, reason: RevokeReason, now: Date, accountId?: string): Promise<void>;
  revokeAll(accountId: string, reason: RevokeReason, now: Date): Promise<void>;
}

export class DrizzleSessionStore implements SessionStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async create(
    session: { id: string; accountId: string; deviceHash: Buffer; expiresAt: Date },
    token: NewRefreshToken,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.insert(sessions).values(session);
      await tx.insert(refreshTokens).values({ ...token, sessionId: session.id });
    });
  }

  async findToken(tokenHash: Buffer): Promise<FoundToken | undefined> {
    const [row] = await this.#db
      .select({
        tokenId: refreshTokens.id,
        usedAt: refreshTokens.usedAt,
        tokenExpiresAt: refreshTokens.expiresAt,
        sessionId: sessions.id,
        accountId: sessions.accountId,
        deviceHash: sessions.deviceHash,
        sessionExpiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(refreshTokens)
      .innerJoin(sessions, eq(refreshTokens.sessionId, sessions.id))
      .where(eq(refreshTokens.tokenHash, tokenHash));
    return row;
  }

  async markUsed(tokenId: string, now: Date): Promise<boolean> {
    const rows = await this.#db
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(and(eq(refreshTokens.id, tokenId), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length === 1;
  }

  async rotate(sessionId: string, token: NewRefreshToken, now: Date): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.insert(refreshTokens).values({ ...token, sessionId });
      await tx
        .update(sessions)
        .set({ expiresAt: token.expiresAt, lastUsedAt: now })
        .where(eq(sessions.id, sessionId));
    });
  }

  async revoke(
    sessionId: string,
    reason: RevokeReason,
    now: Date,
    accountId?: string,
  ): Promise<void> {
    await this.#db
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
          accountId === undefined ? sql`true` : eq(sessions.accountId, accountId),
        ),
      );
  }

  async revokeAll(accountId: string, reason: RevokeReason, now: Date): Promise<void> {
    await this.#db
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
  }
}
