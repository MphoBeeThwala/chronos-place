import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Point } from './location.js';
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
  /** Stores an already snapped point, or clears it (null). False when there is no profile. */
  setLocation(accountId: string, point: Point | null, now: Date): Promise<boolean>;
  /**
   * Profiles `viewerId` may be shown, with the distance in metres between the two stored points
   * (null when either has none). Leaves out the viewer and paused profiles; private ones carry
   * their flag for matching to decide. Never returns a coordinate.
   */
  publicProfiles(viewerId: string, ids: readonly string[]): Promise<PublicProfileRecord[]>;
  candidateViewer(viewerId: string): Promise<CandidateViewer | undefined>;
  candidates(
    viewerId: string,
    viewerAge: number,
    limit: number,
    after?: { distanceMeters: number; accountId: string },
  ): Promise<CandidateRow[]>;
}

export interface PublicProfileRecord {
  accountId: string;
  displayName: string;
  bio: string | null;
  intent: Intent;
  gender: string | null;
  pronouns: string | null;
  areaLabel: string | null;
  distanceMeters: number | null;
  /** Never sent to other members: matching decides who may see a private profile. */
  privateMode: boolean;
  prompts: PromptAnswer[];
  interests: string[];
}

/** A candidate for discovery (ADR-0026): an id, the private flag and the keyset position. */
export interface CandidateRow {
  accountId: string;
  privateMode: boolean;
  distanceMeters: number;
}

/** What candidate search needs about the viewer. Never leaves the service. */
export interface CandidateViewer {
  hasLocation: boolean;
  ageMin: number;
  ageMax: number;
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

  async setLocation(accountId: string, point: Point | null, now: Date): Promise<boolean> {
    const location =
      point === null
        ? null
        : sql`ST_SetSRID(ST_MakePoint(${point.longitude}, ${point.latitude}), 4326)::geography`;
    const updated = await this.#db
      .update(profiles)
      .set({ location, locationUpdatedAt: point === null ? null : now, updatedAt: now })
      .where(eq(profiles.accountId, accountId))
      .returning({ accountId: profiles.accountId });
    return updated.length > 0;
  }

  /** The viewer's own search settings, or undefined without a profile. */
  async candidateViewer(viewerId: string): Promise<CandidateViewer | undefined> {
    const [row] = await this.#db
      .select({
        hasLocation: sql<boolean>`${profiles.location} is not null`,
        ageMin: preferences.ageMin,
        ageMax: preferences.ageMax,
      })
      .from(profiles)
      .innerJoin(preferences, eq(preferences.accountId, profiles.accountId))
      .where(eq(profiles.accountId, viewerId));
    return row;
  }

  /**
   * Visible members within the viewer's distance, nearest first (ADR-0026), whose intent the viewer
   * wants and whose gender fits both members' preferences, and whose own age range includes the
   * viewer. The candidates' ages are checked against the viewer's range afterwards, with identity.
   * Points are compared inside the database; no coordinate is selected.
   */
  async candidates(
    viewerId: string,
    viewerAge: number,
    limit: number,
    after?: { distanceMeters: number; accountId: string },
  ): Promise<CandidateRow[]> {
    const distance = sql`ST_Distance(c.location, v.location)`;
    const { rows } = await this.#db.execute<{
      account_id: string;
      private_mode: boolean;
      distance: number;
    }>(sql`
      with v as (
        select p.location, p.gender, pr.max_distance_km, pr.intents, pr.genders
          from profile.profiles p
          join profile.preferences pr on pr.account_id = p.account_id
         where p.account_id = ${viewerId} and p.location is not null
      )
      select c.account_id, c.private_mode, ${distance} as distance
        from v, profile.profiles c
        join profile.preferences cp on cp.account_id = c.account_id
       where c.account_id <> ${viewerId}
         and c.visible
         and c.location is not null
         and ST_DWithin(c.location, v.location, v.max_distance_km * 1000)
         and (cardinality(v.intents) = 0 or c.intent = any(v.intents))
         and (cardinality(v.genders) = 0 or c.gender = any(v.genders))
         and (cardinality(cp.genders) = 0 or v.gender = any(cp.genders))
         and cp.age_min <= ${viewerAge} and cp.age_max >= ${viewerAge}
         ${after ? sql`and (${distance}, c.account_id) > (${after.distanceMeters}, ${after.accountId}::uuid)` : sql``}
       order by distance, c.account_id
       limit ${limit}`);
    return rows.map((r) => ({
      accountId: r.account_id,
      privateMode: r.private_mode,
      distanceMeters: r.distance,
    }));
  }

  async publicProfiles(viewerId: string, ids: readonly string[]): Promise<PublicProfileRecord[]> {
    if (ids.length === 0) return [];
    // The distance is worked out inside the database; no coordinate is ever selected.
    const viewerLocation = sql`(select v.location from ${profiles} v where v.account_id = ${viewerId})`;
    const rows = await this.#db
      .select({
        accountId: profiles.accountId,
        displayName: profiles.displayName,
        bio: profiles.bio,
        intent: profiles.intent,
        gender: profiles.gender,
        pronouns: profiles.pronouns,
        areaLabel: profiles.areaLabel,
        distanceMeters: sql<number | null>`ST_Distance(${profiles.location}, ${viewerLocation})`,
        privateMode: profiles.privateMode,
      })
      .from(profiles)
      .where(
        and(
          inArray(profiles.accountId, [...ids]),
          ne(profiles.accountId, viewerId),
          eq(profiles.visible, true),
        ),
      );
    if (rows.length === 0) return [];
    const found = rows.map((r) => r.accountId);
    const [prompts, interests] = await Promise.all([
      this.#db
        .select({
          accountId: profilePrompts.accountId,
          promptId: profilePrompts.promptId,
          answer: profilePrompts.answer,
        })
        .from(profilePrompts)
        .where(inArray(profilePrompts.accountId, found))
        .orderBy(asc(profilePrompts.accountId), asc(profilePrompts.position)),
      this.#db
        .select({ accountId: profileInterests.accountId, id: profileInterests.interestId })
        .from(profileInterests)
        .where(inArray(profileInterests.accountId, found))
        .orderBy(asc(profileInterests.interestId)),
    ]);
    return rows.map((r) => ({
      ...r,
      prompts: prompts
        .filter((p) => p.accountId === r.accountId)
        .map(({ promptId, answer }) => ({ promptId, answer })),
      interests: interests.filter((i) => i.accountId === r.accountId).map((i) => i.id),
    }));
  }
}
