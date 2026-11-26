import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  type AccountStatus,
  consentRecords,
  type ConsentType,
  sessions,
  verificationAttempts,
} from '../db/schema.js';
import { PHONE_FIELD } from '../otp/otp.service.js';

/** Everything identity holds about a member, for "Download my data" (ADR-0025 c, h). */
export interface AccountExport {
  status: AccountStatus;
  /** The member's own number, E.164. The one way it ever leaves identity (ADR-0025 h). */
  phone: string;
  dateOfBirth: { year: number; month: number; day: number } | undefined;
  createdAt: Date;
  consents: { type: ConsentType; policyVersion: string; granted: boolean; recordedAt: Date }[];
  /** Dates only: device ids are never exported. */
  sessions: { createdAt: Date; lastUsedAt: Date; expiresAt: Date; revokedAt: Date | null }[];
  verifications: {
    provider: string;
    outcome: string;
    failure: string | null;
    createdAt: Date;
    decidedAt: Date | null;
  }[];
}

const EXPORTABLE: readonly AccountStatus[] = ['pending_onboarding', 'active'];
const NOT_AVAILABLE = 'This account cannot be exported.';

export class AccountExporter {
  readonly #db: NodePgDatabase;
  readonly #keyring: SubjectKeyring;
  readonly #logger: Logger;

  constructor(deps: { db: NodePgDatabase; keyring: SubjectKeyring; logger: Logger }) {
    this.#db = deps.db;
    this.#keyring = deps.keyring;
    this.#logger = deps.logger;
  }

  async export(accountId: string): Promise<AccountExport> {
    const [account] = await this.#db.select().from(accounts).where(eq(accounts.id, accountId));
    if (
      !account ||
      !EXPORTABLE.includes(account.status) ||
      !account.phoneCiphertext ||
      !account.phoneNonce
    ) {
      throw new DomainError('failed_precondition', NOT_AVAILABLE);
    }
    const phone = String(
      await this.#keyring.decrypt(accountId, PHONE_FIELD, {
        ciphertext: account.phoneCiphertext,
        nonce: account.phoneNonce,
      }),
    );
    const consents = await this.#db
      .select({
        type: consentRecords.consentType,
        policyVersion: consentRecords.policyVersion,
        granted: consentRecords.granted,
        recordedAt: consentRecords.recordedAt,
      })
      .from(consentRecords)
      .where(eq(consentRecords.accountId, accountId))
      .orderBy(asc(consentRecords.recordedAt), asc(consentRecords.id));
    const sessionRows = await this.#db
      .select({
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.accountId, accountId))
      .orderBy(asc(sessions.createdAt));
    const v = verificationAttempts;
    const verifications = await this.#db
      .select({
        provider: v.provider,
        outcome: v.outcome,
        failure: v.failure,
        createdAt: v.createdAt,
        decidedAt: v.decidedAt,
      })
      .from(v)
      .where(eq(v.accountId, accountId))
      .orderBy(asc(v.createdAt));

    this.#logger.info({ accountId }, 'account data exported');
    return {
      status: account.status,
      phone,
      dateOfBirth: account.dateOfBirth ? calendarDate(account.dateOfBirth) : undefined,
      createdAt: account.createdAt,
      consents,
      sessions: sessionRows,
      verifications,
    };
  }
}

/** 'YYYY-MM-DD' as stored, to its parts. */
function calendarDate(value: string) {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
}
