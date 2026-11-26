import type { SubjectKeyring } from '@chronos/crypto';
import { DomainError } from '@chronos/service-kit';
import { healthProfiles } from '@chronos/vault-db';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AccessLog } from '../vault/access-log.js';
import type { SubjectDirectory } from '../vault/subjects.js';
import {
  healthProfileSchema,
  OTHER_CODE,
  type HealthProfile,
  type OwnHealthProfile,
} from './health-profile.js';
import type { ConditionTaxonomy } from './taxonomy.js';

/** Field name bound into the ciphertext (with the vault id), so a sealed profile only opens here. */
export const PROFILE_FIELD = 'health_profile';

// Fixed messages: they never repeat what was sent (CLAUDE.md coding standards).
export const INVALID_PROFILE = 'Invalid health profile.';
export const PROFILE_CHANGED = 'Health profile changed elsewhere; reload and try again.';

export interface HealthProfileDeps {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  keyring: SubjectKeyring;
  taxonomy: ConditionTaxonomy;
  accessLog: AccessLog;
}

/** A member's own health profile: save it (sealed) and read it back (audited). */
export class HealthProfileService {
  readonly #deps: HealthProfileDeps;

  constructor(deps: HealthProfileDeps) {
    this.#deps = deps;
  }

  /**
   * Saves the member's whole profile. `expectedVersion` is the version last read, 0 to create;
   * a mismatch means another device saved first. Returns the new version.
   */
  async upsert(accountId: string, input: unknown, expectedVersion: number): Promise<number> {
    const profile = await this.#validate(input);
    const { db, subjects, keyring } = this.#deps;
    const vaultId = await subjects.findOrCreate(accountId);
    const sealed = await keyring.encrypt(vaultId, PROFILE_FIELD, profile);
    const payload = {
      payloadCt: Buffer.from(sealed.ciphertext),
      payloadNonce: Buffer.from(sealed.nonce),
    };

    const rows =
      expectedVersion === 0
        ? await db
            .insert(healthProfiles)
            .values({ vaultId, ...payload })
            .onConflictDoNothing()
            .returning({ version: healthProfiles.version })
        : await db
            .update(healthProfiles)
            .set({ ...payload, version: sql`${healthProfiles.version} + 1`, updatedAt: sql`now()` })
            .where(
              and(eq(healthProfiles.vaultId, vaultId), eq(healthProfiles.version, expectedVersion)),
            )
            .returning({ version: healthProfiles.version });
    const [saved] = rows;
    if (saved === undefined) throw new DomainError('aborted', PROFILE_CHANGED);
    return saved.version;
  }

  /**
   * The member's own profile, or undefined when they have none. The read is recorded in the
   * access log before anything is returned; if recording fails, nothing is returned.
   */
  async getOwn(accountId: string): Promise<OwnHealthProfile | undefined> {
    const { db, subjects, keyring, accessLog } = this.#deps;
    const vaultId = await subjects.find(accountId);
    // No vault id: nothing about this member is in the vault, so nothing is read.
    if (vaultId === undefined) return undefined;

    await accessLog.record({
      vaultId,
      accessor: `account:${accountId}`,
      purpose: 'profile_view',
      decision: 'allow',
      reason: 'self',
    });
    const [row] = await db.select().from(healthProfiles).where(eq(healthProfiles.vaultId, vaultId));
    if (row === undefined) return undefined;

    const opened = await keyring.decrypt(vaultId, PROFILE_FIELD, {
      ciphertext: new Uint8Array(row.payloadCt),
      nonce: new Uint8Array(row.payloadNonce),
    });
    return {
      profile: healthProfileSchema.parse(opened),
      visibility: row.visibility,
      filterOptIn: row.filterOptIn,
      version: row.version,
    };
  }

  async #validate(input: unknown): Promise<HealthProfile> {
    const parsed = healthProfileSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('invalid_argument', INVALID_PROFILE);
    const profile: HealthProfile = {
      conditions: parsed.data.conditions,
      ...(parsed.data.freeText ? { freeText: parsed.data.freeText } : {}),
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    };
    const codes = profile.conditions.map((c) => c.code);
    const active = await this.#deps.taxonomy.activeCodes();
    const valid =
      new Set(codes).size === codes.length &&
      codes.every((code) => active.has(code)) &&
      (!codes.includes(OTHER_CODE) || profile.freeText !== undefined);
    if (!valid) throw new DomainError('invalid_argument', INVALID_PROFILE);
    return profile;
  }
}
