import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import { INTERESTS, isInterestId, isPromptId, PROMPTS } from '../catalogue.js';
import type { Intent } from '../db/schema.js';
import type {
  OwnProfileRecord,
  PreferencesRecord,
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
  logger: Logger;
  now?: () => Date;
}

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
