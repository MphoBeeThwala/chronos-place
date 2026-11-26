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
export const NO_PROFILE = 'Create your health profile first.';

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
    const profile = await this.#validate(accountId, input);
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
    const { subjects, accessLog } = this.#deps;
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
    const row = await this.open(vaultId);
    if (row === undefined) return undefined;
    return {
      profile: row.profile,
      visibility: row.visibility,
      filterOptIn: row.filterOptIn,
      version: row.version,
    };
  }

  /**
   * Sets who may see the profile and the filter opt-in (counts as a change: the version goes up).
   * Not a read of health content, so nothing is audited.
   */
  async setVisibility(
    accountId: string,
    visibility: OwnHealthProfile['visibility'],
    filterOptIn: boolean,
  ): Promise<{ visibility: OwnHealthProfile['visibility']; filterOptIn: boolean }> {
    const { db, subjects } = this.#deps;
    const vaultId = await subjects.find(accountId);
    const [row] =
      vaultId === undefined
        ? []
        : await db
            .update(healthProfiles)
            .set({
              visibility,
              filterOptIn,
              version: sql`${healthProfiles.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(healthProfiles.vaultId, vaultId))
            .returning({
              visibility: healthProfiles.visibility,
              filterOptIn: healthProfiles.filterOptIn,
            });
    if (row === undefined) throw new DomainError('failed_precondition', NO_PROFILE);
    return row;
  }

  /**
   * Reads and decrypts a stored profile. **Callers must record the read in the access log first**
   * (CLAUDE.md rule 9); this method does not.
   */
  async open(vaultId: string) {
    const { db, keyring } = this.#deps;
    const [row] = await db.select().from(healthProfiles).where(eq(healthProfiles.vaultId, vaultId));
    if (row === undefined) return undefined;
    const opened = await keyring.decrypt(vaultId, PROFILE_FIELD, {
      ciphertext: new Uint8Array(row.payloadCt),
      nonce: new Uint8Array(row.payloadNonce),
    });
    return { ...row, profile: healthProfileSchema.parse(opened) };
  }

  /**
   * Retired conditions (M2.2 decision): a member keeps one already on their profile and can save
   * other changes, but nobody can newly add it. Only then is the stored profile read, audited as
   * `self_update`.
   */
  async #keepsRetired(accountId: string, retired: string[]): Promise<boolean> {
    const vaultId = await this.#deps.subjects.find(accountId);
    if (vaultId === undefined) return false;
    await this.#deps.accessLog.record({
      vaultId,
      accessor: `account:${accountId}`,
      purpose: 'profile_view',
      decision: 'allow',
      reason: 'self_update',
    });
    const stored = await this.open(vaultId);
    const held = new Set(stored?.profile.conditions.map((c) => c.code));
    return retired.every((code) => held.has(code));
  }

  async #validate(accountId: string, input: unknown): Promise<HealthProfile> {
    const parsed = healthProfileSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('invalid_argument', INVALID_PROFILE);
    const profile: HealthProfile = {
      conditions: parsed.data.conditions,
      ...(parsed.data.freeText ? { freeText: parsed.data.freeText } : {}),
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    };
    const codes = profile.conditions.map((c) => c.code);
    const known = await this.#deps.taxonomy.codes();
    const valid =
      new Set(codes).size === codes.length &&
      codes.every((code) => known.has(code)) &&
      (!codes.includes(OTHER_CODE) || profile.freeText !== undefined);
    if (!valid) throw new DomainError('invalid_argument', INVALID_PROFILE);
    const retired = codes.filter((code) => known.get(code) === false);
    if (retired.length > 0 && !(await this.#keepsRetired(accountId, retired))) {
      throw new DomainError('invalid_argument', INVALID_PROFILE);
    }
    return profile;
  }
}
