import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { INTERESTS, isInterestId, isPromptId, PROMPTS } from '../catalogue.js';
import type { Intent } from '../db/schema.js';
import type { MemberFacts } from '../identity/member-facts.js';
import type { BlockVisibility } from '../matching/visibility.js';
import { displayDistanceKm, type Point, snap } from './location.js';
import type {
  OwnProfileRecord,
  PreferencesRecord,
  PublicProfileRecord,
  ProfileChanges,
  ProfileFields,
  ProfileStore,
  PromptAnswer,
} from './profile-store.js';
import {
  AGE_CEILING,
  AGE_FLOOR,
  cleanText,
  DEFAULT_PREFERENCES,
  DISTANCE_MAX_KM,
  DISTANCE_MIN_KM,
  LIMITS,
  MESSAGES,
} from './text.js';

export interface ProfileUpdate {
  displayName?: string;
  bio?: string;
  intent?: Intent;
  gender?: string;
  pronouns?: string;
  areaLabel?: string;
  privateMode?: boolean;
  visible?: boolean;
  prompts?: PromptAnswer[];
  interests?: string[];
}

export interface PreferencesUpdate {
  ageMin?: number;
  ageMax?: number;
  maxDistanceKm?: number;
  intents?: Intent[];
  genders?: string[];
}

export interface ProfileServiceDeps {
  profiles: ProfileStore;
  /** Ages and verified badges from identity (ADR-0023 f). */
  facts: MemberFacts;
  /** Blocks from matching: blocked pairs never see each other (M3.1). */
  visibility: BlockVisibility;
  logger: Logger;
  now?: () => Date;
}

/** The most profiles one request may ask for. */
export const MAX_PUBLIC_PROFILES = 50;
/** The largest candidate page discovery may ask for (ADR-0026). */
export const MAX_CANDIDATES = 500;

export type CandidatesOutcome = 'ok' | 'no_profile' | 'no_location';
/** Ranking v1's signals, each 0 to 100 (ADR-0027). No health data, no distance, no date. */
export interface RankingFeatures {
  closeness: number;
  activity: number;
  mutualFit: number;
  completeness: number;
  newness: number;
}

/** Activity buckets as scores (approved, ADR-0027). */
export const ACTIVITY_SCORE = { today: 100, this_week: 60, this_month: 30, longer: 0 } as const;
/** The verified badge's share of completeness. */
export const VERIFIED_SCORE = 25;

export interface CandidatePage {
  outcome: CandidatesOutcome;
  candidates: { accountId: string; privateMode: boolean; features: RankingFeatures }[];
  /** Where the next page starts; undefined when there is none. */
  next: { distanceMeters: number; accountId: string } | undefined;
}
const LOCATION_SET = 'location set';
const LOCATION_CLEARED = 'location cleared';

export interface PublicProfile extends Omit<PublicProfileRecord, 'distanceMeters' | 'privateMode'> {
  age: number;
  verified: boolean;
  /** Undefined when either member has no location. */
  distanceKm: number | undefined;
}

const publicView = (
  record: PublicProfileRecord,
  fact: { age: number; verified: boolean },
): PublicProfile => ({
  accountId: record.accountId,
  displayName: record.displayName,
  bio: record.bio,
  intent: record.intent,
  gender: record.gender,
  pronouns: record.pronouns,
  areaLabel: record.areaLabel,
  prompts: record.prompts,
  interests: record.interests,
  // The private flag stays here: nobody is told that a profile is private.
  age: fact.age,
  verified: fact.verified,
  distanceKm: record.distanceMeters === null ? undefined : displayDistanceKm(record.distanceMeters),
});

const invalid = (message: string): never => {
  throw new DomainError('invalid_argument', message);
};

/**
 * Members' own profiles and preferences (TASKS M1.5, ADR-0023). Free text is cleaned and capped
 * here and is never logged: members may write about anything, health included, in a bio (decision i).
 */
export class ProfileService {
  readonly #d: Required<ProfileServiceDeps>;

  constructor(deps: ProfileServiceDeps) {
    this.#d = { now: () => new Date(), ...deps };
  }

  catalogue() {
    return { prompts: [...PROMPTS], interests: [...INTERESTS] };
  }

  async getOwn(accountId: string): Promise<OwnProfileRecord> {
    const record = await this.#d.profiles.get(accountId);
    if (!record) throw new DomainError('not_found', MESSAGES.needsProfile);
    return record;
  }

  async update(accountId: string, update: ProfileUpdate): Promise<OwnProfileRecord> {
    const changes = this.#changes(update);
    if (await this.#d.profiles.update(accountId, changes, this.#d.now())) {
      this.#d.logger.info({ accountId }, 'profile updated');
      return this.getOwn(accountId);
    }

    // No profile yet: this save creates it (decision g).
    const { displayName, intent } = changes.fields;
    if (displayName === undefined || intent === undefined) invalid(MESSAGES.needsBasics);
    const fields: ProfileFields = {
      displayName: displayName as string,
      intent: intent as Intent,
      bio: changes.fields.bio ?? null,
      gender: changes.fields.gender ?? null,
      pronouns: changes.fields.pronouns ?? null,
      areaLabel: changes.fields.areaLabel ?? null,
      privateMode: changes.fields.privateMode ?? false,
      visible: changes.fields.visible ?? true,
    };
    const extras = { prompts: changes.prompts ?? [], interests: changes.interests ?? [] };
    const created = await this.#d.profiles.create(accountId, fields, extras, {
      ...DEFAULT_PREFERENCES,
    });
    if (!created) {
      // Another request created it first; apply this one on top.
      await this.#d.profiles.update(accountId, changes, this.#d.now());
    } else {
      this.#d.logger.info({ accountId }, 'profile created');
    }
    return this.getOwn(accountId);
  }

  async updatePreferences(accountId: string, update: PreferencesUpdate): Promise<OwnProfileRecord> {
    const { preferences: current } = await this.getOwn(accountId);
    const next: PreferencesRecord = {
      ageMin: update.ageMin ?? current.ageMin,
      ageMax: update.ageMax ?? current.ageMax,
      maxDistanceKm: update.maxDistanceKm ?? current.maxDistanceKm,
      intents: update.intents ? [...new Set(update.intents)].sort() : current.intents,
      genders: update.genders ? this.#genders(update.genders) : current.genders,
    };
    const ages = [next.ageMin, next.ageMax];
    if (
      !ages.every(Number.isInteger) ||
      next.ageMin < AGE_FLOOR ||
      next.ageMax > AGE_CEILING ||
      next.ageMin > next.ageMax
    ) {
      invalid(MESSAGES.ages);
    }
    if (
      !Number.isInteger(next.maxDistanceKm) ||
      next.maxDistanceKm < DISTANCE_MIN_KM ||
      next.maxDistanceKm > DISTANCE_MAX_KM
    ) {
      invalid(MESSAGES.distance);
    }
    if (!(await this.#d.profiles.setPreferences(accountId, next, this.#d.now()))) {
      throw new DomainError('not_found', MESSAGES.needsProfile);
    }
    this.#d.logger.info({ accountId }, 'preferences updated');
    return this.getOwn(accountId);
  }

  /**
   * Stores the member's location snapped to about 1 km, whatever precision the client sent, or
   * clears it (ADR-0023 a). The point is never logged.
   */
  async setLocation(accountId: string, point: Point | null): Promise<OwnProfileRecord> {
    const stored = point === null ? null : snap(point);
    if (!(await this.#d.profiles.setLocation(accountId, stored, this.#d.now()))) {
      throw new DomainError('not_found', MESSAGES.needsProfile);
    }
    if (point === null) this.#d.logger.info({ accountId }, LOCATION_CLEARED);
    else this.#d.logger.info({ accountId }, LOCATION_SET);
    return this.getOwn(accountId);
  }

  /**
   * Profiles as `viewerId` may see them (M1.5 AC): a rounded distance and never a coordinate,
   * whole-year ages from identity, only active members, and never anyone blocked either way
   * (M3.1), and a private profile only to members its owner liked. Keeps the request order.
   */
  async publicProfiles(viewerId: string, ids: readonly string[]): Promise<PublicProfile[]> {
    const requested = [...new Set(ids)].filter((id) => id !== viewerId);
    if (requested.length > MAX_PUBLIC_PROFILES) invalid(MESSAGES.tooMany);
    if (requested.length === 0) return [];
    const records = await this.#d.profiles.publicProfiles(viewerId, requested);
    if (records.length === 0) return [];
    const unique = await this.#d.visibility.visibleTo(
      viewerId,
      requested.filter((id) => records.some((r) => r.accountId === id)),
      records.filter((r) => r.privateMode).map((r) => r.accountId),
    );
    if (unique.length === 0) return [];
    const facts = await this.#d.facts.get(unique);
    const byId = new Map(records.map((r) => [r.accountId, r]));
    return unique.flatMap((id) => {
      const record = byId.get(id);
      const fact = facts.get(id);
      return record && fact ? [publicView(record, fact)] : [];
    });
  }

  /**
   * One page of discovery candidates for the viewer, nearest first (ADR-0026, approved: age and
   * gender must fit both ways; no location means no feed). Only ids and the private flag leave.
   */
  async candidates(
    viewerId: string,
    pageSize: number,
    after?: { distanceMeters: number; accountId: string },
  ): Promise<CandidatePage> {
    const empty = (outcome: CandidatesOutcome): CandidatePage => ({
      outcome,
      candidates: [],
      next: undefined,
    });
    const viewer = await this.#d.profiles.candidateViewer(viewerId);
    if (!viewer) return empty('no_profile');
    if (!viewer.hasLocation) return empty('no_location');
    const viewerAge = (await this.#d.facts.get([viewerId])).get(viewerId)?.age;
    // An account that is not active sees nobody.
    if (viewerAge === undefined) return empty('ok');
    const size = Math.min(Math.max(pageSize, 1), MAX_CANDIDATES);
    const rows = await this.#d.profiles.candidates(viewerId, viewerAge, size, after, this.#d.now());
    const facts = await this.#d.facts.get(
      rows.map((r) => r.accountId),
      { activity: true },
    );
    const last = rows.at(-1);
    return {
      outcome: 'ok',
      candidates: rows.flatMap((r) => {
        const fact = facts.get(r.accountId);
        if (fact === undefined || fact.age < viewer.ageMin || fact.age > viewer.ageMax) return [];
        return [
          {
            accountId: r.accountId,
            privateMode: r.privateMode,
            features: {
              closeness: r.signals.closeness,
              activity: ACTIVITY_SCORE[fact.activity ?? 'longer'],
              mutualFit: r.signals.mutualFit,
              completeness:
                r.signals.completenessWithoutBadge + (fact.verified ? VERIFIED_SCORE : 0),
              newness: r.signals.newness,
            },
          },
        ];
      }),
      next:
        rows.length === size && last
          ? { distanceMeters: last.distanceMeters, accountId: last.accountId }
          : undefined,
    };
  }

  #changes(update: ProfileUpdate): ProfileChanges {
    const fields: Partial<ProfileFields> = {};
    if (update.displayName !== undefined) {
      const name = cleanText(update.displayName, LIMITS.displayName);
      if (name === null) invalid(MESSAGES.displayName);
      fields.displayName = name as string;
    }
    if (update.bio !== undefined)
      fields.bio = cleanText(update.bio, LIMITS.bio, { multiline: true });
    if (update.gender !== undefined) fields.gender = cleanText(update.gender, LIMITS.gender);
    if (update.pronouns !== undefined)
      fields.pronouns = cleanText(update.pronouns, LIMITS.pronouns);
    if (update.areaLabel !== undefined)
      fields.areaLabel = cleanText(update.areaLabel, LIMITS.areaLabel);
    if (update.intent !== undefined) fields.intent = update.intent;
    if (update.privateMode !== undefined) fields.privateMode = update.privateMode;
    if (update.visible !== undefined) fields.visible = update.visible;

    const changes: ProfileChanges = { fields };
    if (update.prompts !== undefined) changes.prompts = this.#prompts(update.prompts);
    if (update.interests !== undefined) changes.interests = this.#interests(update.interests);
    return changes;
  }

  #prompts(prompts: PromptAnswer[]): PromptAnswer[] {
    if (prompts.length > LIMITS.prompts) invalid(MESSAGES.prompts);
    const ids = prompts.map((p) => p.promptId);
    if (!ids.every(isPromptId) || new Set(ids).size !== ids.length) invalid(MESSAGES.prompts);
    return prompts.flatMap((p) => {
      const answer = cleanText(p.answer, LIMITS.promptAnswer, { multiline: true });
      // An empty answer removes that prompt.
      return answer === null ? [] : [{ promptId: p.promptId, answer }];
    });
  }

  #interests(ids: string[]): string[] {
    const unique = [...new Set(ids)];
    if (unique.length > LIMITS.interests || !unique.every(isInterestId))
      invalid(MESSAGES.interests);
    return unique.sort();
  }

  #genders(genders: string[]): string[] {
    if (genders.length > LIMITS.genderPreferences) invalid(MESSAGES.tooLong);
    const cleaned = genders.flatMap((g) => {
      const value = cleanText(g, LIMITS.gender);
      return value === null ? [] : [value];
    });
    return [...new Set(cleaned)];
  }
}
