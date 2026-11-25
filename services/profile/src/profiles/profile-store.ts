import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type Intent,
  preferences,
  profileInterests,
  profilePrompts,
  profiles,
} from '../db/schema.js';

export interface PromptAnswer {
  promptId: string;
  answer: string;
}

/** The editable fields of a profile. Null clears an optional field. */
export interface ProfileFields {
  displayName: string;
  bio: string | null;
  intent: Intent;
  gender: string | null;
  pronouns: string | null;
  areaLabel: string | null;
  privateMode: boolean;
  visible: boolean;
}

export interface OwnProfile extends ProfileFields {
  accountId: string;
  prompts: PromptAnswer[];
  interests: string[];
  hasLocation: boolean;
}

export interface PreferencesRecord {
  ageMin: number;
  ageMax: number;
  maxDistanceKm: number;
  /** Empty means every intent. */
  intents: Intent[];
  /** Empty means everyone. */
  genders: string[];
}

export interface OwnProfileRecord {
  profile: OwnProfile;
  preferences: PreferencesRecord;
}

export interface ProfileChanges {
  fields: Partial<ProfileFields>;
  /** When set, replaces every prompt answer. */
  prompts?: PromptAnswer[];
  /** When set, replaces every interest. */
  interests?: string[];
}

export interface ProfileStore {
  get(accountId: string): Promise<OwnProfileRecord | undefined>;
  /** Creates the profile with its preferences, or returns false if one already exists (a race). */
  create(
    accountId: string,
    fields: ProfileFields,
    extras: { prompts: PromptAnswer[]; interests: string[] },
    preferences: PreferencesRecord,
  ): Promise<boolean>;
  /** Applies changes in one transaction. False when there is no profile. */
  update(accountId: string, changes: ProfileChanges, now: Date): Promise<boolean>;
  /** Replaces the preferences. False when there is no profile. */
  setPreferences(accountId: string, prefs: PreferencesRecord, now: Date): Promise<boolean>;
}

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

async function replaceExtras(
  tx: Tx,
  accountId: string,
  extras: { prompts?: PromptAnswer[]; interests?: string[] },
): Promise<void> {
  if (extras.prompts) {
    await tx.delete(profilePrompts).where(eq(profilePrompts.accountId, accountId));
    if (extras.prompts.length > 0) {
      await tx
        .insert(profilePrompts)
        .values(extras.prompts.map((p, position) => ({ accountId, position, ...p })));
    }
  }
  if (extras.interests) {
    await tx.delete(profileInterests).where(eq(profileInterests.accountId, accountId));
    if (extras.interests.length > 0) {
      await tx
        .insert(profileInterests)
        .values(extras.interests.map((interestId) => ({ accountId, interestId })));
    }
  }
}

export class DrizzleProfileStore implements ProfileStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async get(accountId: string): Promise<OwnProfileRecord | undefined> {
    const [row] = await this.#db
      .select({
        accountId: profiles.accountId,
        displayName: profiles.displayName,
        bio: profiles.bio,
        intent: profiles.intent,
        gender: profiles.gender,
        pronouns: profiles.pronouns,
        areaLabel: profiles.areaLabel,
        privateMode: profiles.privateMode,
        visible: profiles.visible,
        // The location is never read out; only whether one is set.
        hasLocation: sql<boolean>`${profiles.location} is not null`,
        ageMin: preferences.ageMin,
        ageMax: preferences.ageMax,
        maxDistanceKm: preferences.maxDistanceKm,
        intents: preferences.intents,
        genders: preferences.genders,
      })
      .from(profiles)
      .innerJoin(preferences, eq(preferences.accountId, profiles.accountId))
      .where(eq(profiles.accountId, accountId));
    if (!row) return undefined;
    const [prompts, interests] = await Promise.all([
      this.#db
        .select({ promptId: profilePrompts.promptId, answer: profilePrompts.answer })
        .from(profilePrompts)
        .where(eq(profilePrompts.accountId, accountId))
        .orderBy(asc(profilePrompts.position)),
      this.#db
        .select({ id: profileInterests.interestId })
        .from(profileInterests)
        .where(eq(profileInterests.accountId, accountId))
        .orderBy(asc(profileInterests.interestId)),
    ]);
    const { ageMin, ageMax, maxDistanceKm, intents, genders, ...profile } = row;
    return {
      profile: { ...profile, prompts, interests: interests.map((i) => i.id) },
      preferences: { ageMin, ageMax, maxDistanceKm, intents: intents as Intent[], genders },
    };
  }

  create(
    accountId: string,
    fields: ProfileFields,
    extras: { prompts: PromptAnswer[]; interests: string[] },
    prefs: PreferencesRecord,
  ): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const inserted = await tx
        .insert(profiles)
        .values({ accountId, ...fields })
        .onConflictDoNothing()
        .returning({ accountId: profiles.accountId });
      if (inserted.length === 0) return false;
      await tx.insert(preferences).values({ accountId, ...prefs });
      await replaceExtras(tx, accountId, extras);
      return true;
    });
  }

  update(accountId: string, changes: ProfileChanges, now: Date): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const updated = await tx
        .update(profiles)
        .set({ ...changes.fields, updatedAt: now })
        .where(eq(profiles.accountId, accountId))
        .returning({ accountId: profiles.accountId });
      if (updated.length === 0) return false;
      await replaceExtras(tx, accountId, changes);
      return true;
    });
  }

  async setPreferences(accountId: string, prefs: PreferencesRecord, now: Date): Promise<boolean> {
    const updated = await this.#db
      .update(preferences)
      .set({ ...prefs, updatedAt: now })
      .where(eq(preferences.accountId, accountId))
      .returning({ accountId: preferences.accountId });
    return updated.length > 0;
  }
}
