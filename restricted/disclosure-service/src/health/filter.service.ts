import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { filterPreferences, healthProfiles, subjectMap } from '@chronos/vault-db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { AccessLog } from '../vault/access-log.js';
import type { SubjectDirectory } from '../vault/subjects.js';
import { healthProfileSchema, MAX_CONDITIONS, OTHER_CODE } from './health-profile.js';
import { PROFILE_FIELD } from './health-profile.service.js';
import type { ConditionTaxonomy } from './taxonomy.js';

/** Fewer matches than this and nothing is returned, so small results cannot reveal anyone (spec 4.3). */
export const FILTER_K = 20;
export const MAX_CANDIDATES = 500;
export const FILTERS_FIELD = 'filter_preferences';
export const INVALID_FILTERS = 'Invalid filter preferences.';

export type FilterOutcome = 'ok' | 'below_threshold' | 'viewer_not_sharing';

const preferencesSchema = z.object({ codes: z.array(z.string()).max(MAX_CONDITIONS) }).strict();

export interface FilterDeps {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  keyring: SubjectKeyring;
  taxonomy: ConditionTaxonomy;
  accessLog: AccessLog;
  logger?: Logger;
}

/**
 * Condition-aware discovery without leakage (TECHNICAL_SPEC 4.3, ADR-0015, M2.6). The viewer's
 * wanted codes live in the vault, sealed with their own key; discovery sends only the viewer and
 * candidate ids, and gets back account ids only. Candidates are opened in memory (M2.6 decision:
 * no searchable index), and each one read is recorded with purpose `filter`.
 */
export class FilterService {
  readonly #deps: FilterDeps;

  constructor(deps: FilterDeps) {
    this.#deps = deps;
  }

  /** Stores the conditions the member wants matches to have; an empty list deletes them. */
  async setPreferences(accountId: string, codes: readonly string[]): Promise<void> {
    const active = await this.#deps.taxonomy.codes();
    const valid =
      codes.length <= MAX_CONDITIONS &&
      new Set(codes).size === codes.length &&
      codes.every((code) => code !== OTHER_CODE && active.get(code) === true);
    if (!valid) throw new DomainError('invalid_argument', INVALID_FILTERS);

    const { db, subjects, keyring } = this.#deps;
    if (codes.length === 0) {
      const vaultId = await subjects.find(accountId);
      if (vaultId !== undefined) {
        await db.delete(filterPreferences).where(eq(filterPreferences.vaultId, vaultId));
      }
      return;
    }
    const vaultId = await subjects.findOrCreate(accountId);
    const sealed = await keyring.encrypt(vaultId, FILTERS_FIELD, { codes: [...codes] });
    const payload = {
      payloadCt: Buffer.from(sealed.ciphertext),
      payloadNonce: Buffer.from(sealed.nonce),
    };
    await db
      .insert(filterPreferences)
      .values({ vaultId, ...payload })
      .onConflictDoUpdate({
        target: filterPreferences.vaultId,
        set: {
          ...payload,
          version: sql`${filterPreferences.version} + 1`,
          updatedAt: sql`now()`,
        },
      });
  }

  /** The member's own wanted codes (audited as their own read). */
  async getPreferences(accountId: string): Promise<string[]> {
    const vaultId = await this.#deps.subjects.find(accountId);
    if (vaultId === undefined) return [];
    await this.#deps.accessLog.record({
      vaultId,
      accessor: `account:${accountId}`,
      purpose: 'profile_view',
      decision: 'allow',
      reason: 'self_filters',
    });
    return this.#openPreferences(vaultId);
  }

  /**
   * Which candidates match the viewer's stored filters, or nothing: below the threshold, or when
   * the viewer does not share their own profile the same way.
   */
  async filterEligible(
    viewerId: string,
    candidateIds: readonly string[],
  ): Promise<{ outcome: FilterOutcome; eligible: string[] }> {
    const { db, subjects, accessLog } = this.#deps;
    const none = (outcome: FilterOutcome) => ({ outcome, eligible: [] });

    const viewerVault = await subjects.find(viewerId);
    if (viewerVault === undefined || !(await this.#sharesForFilters(viewerVault))) {
      return none('viewer_not_sharing');
    }
    await accessLog.record({
      vaultId: viewerVault,
      accessor: `account:${viewerId}`,
      purpose: 'filter',
      decision: 'allow',
      reason: 'self_filters',
    });
    const wanted = new Set(await this.#openPreferences(viewerVault));
    const candidates = [...new Set(candidateIds)].filter((id) => id !== viewerId);
    if (wanted.size === 0 || candidates.length === 0) return none('below_threshold');

    // Only members who chose "Everyone" and opted in to filters are considered (spec 4.3 step 2).
    const rows = await db
      .select({
        accountId: subjectMap.accountId,
        vaultId: healthProfiles.vaultId,
        payloadCt: healthProfiles.payloadCt,
        payloadNonce: healthProfiles.payloadNonce,
      })
      .from(healthProfiles)
      .innerJoin(subjectMap, eq(subjectMap.vaultId, healthProfiles.vaultId))
      .where(
        and(
          inArray(subjectMap.accountId, candidates),
          eq(healthProfiles.visibility, 'profile'),
          eq(healthProfiles.filterOptIn, true),
        ),
      );
    // Every profile about to be opened is recorded first (CLAUDE.md rule 9).
    await accessLog.recordMany(
      rows.map((row) => ({
        vaultId: row.vaultId,
        accessor: `account:${viewerId}`,
        purpose: 'filter' as const,
        decision: 'allow' as const,
        reason: 'filter_match',
      })),
    );

    const matched = new Set<string>();
    for (const row of rows) {
      if (await this.#hasAny(row, wanted)) matched.add(row.accountId);
    }
    if (matched.size < FILTER_K) return none('below_threshold');
    // In the order discovery sent them.
    return { outcome: 'ok', eligible: candidates.filter((id) => matched.has(id)) };
  }

  async #sharesForFilters(vaultId: string): Promise<boolean> {
    const [row] = await this.#deps.db
      .select({ visibility: healthProfiles.visibility, optIn: healthProfiles.filterOptIn })
      .from(healthProfiles)
      .where(eq(healthProfiles.vaultId, vaultId));
    return row?.visibility === 'profile' && row.optIn;
  }

  async #openPreferences(vaultId: string): Promise<string[]> {
    const [row] = await this.#deps.db
      .select()
      .from(filterPreferences)
      .where(eq(filterPreferences.vaultId, vaultId));
    if (row === undefined) return [];
    const opened = await this.#deps.keyring.decrypt(vaultId, FILTERS_FIELD, {
      ciphertext: new Uint8Array(row.payloadCt),
      nonce: new Uint8Array(row.payloadNonce),
    });
    return preferencesSchema.parse(opened).codes;
  }

  /** A candidate that cannot be opened (e.g. key shredded mid-request) simply does not match. */
  async #hasAny(
    row: { vaultId: string; payloadCt: Buffer; payloadNonce: Buffer },
    wanted: Set<string>,
  ): Promise<boolean> {
    try {
      const opened = await this.#deps.keyring.decrypt(row.vaultId, PROFILE_FIELD, {
        ciphertext: new Uint8Array(row.payloadCt),
        nonce: new Uint8Array(row.payloadNonce),
      });
      return healthProfileSchema.parse(opened).conditions.some((c) => wanted.has(c.code));
    } catch (err) {
      this.#deps.logger?.warn({ err }, 'filter candidate could not be opened');
      return false;
    }
  }
}
