import type {
  OwnProfileRecord,
  PreferencesRecord,
  ProfileChanges,
  ProfileFields,
  ProfileStore,
  PromptAnswer,
} from '../../src/profiles/profile-store.js';

/** Same rules as DrizzleProfileStore, in memory. */
export class InMemoryProfileStore implements ProfileStore {
  readonly rows = new Map<string, OwnProfileRecord>();

  get(accountId: string): Promise<OwnProfileRecord | undefined> {
    const row = this.rows.get(accountId);
    return Promise.resolve(row && structuredClone(row));
  }

  create(
    accountId: string,
    fields: ProfileFields,
    extras: { prompts: PromptAnswer[]; interests: string[] },
    preferences: PreferencesRecord,
  ): Promise<boolean> {
    if (this.rows.has(accountId)) return Promise.resolve(false);
    this.rows.set(accountId, {
      profile: { accountId, ...fields, ...structuredClone(extras), hasLocation: false },
      preferences: structuredClone(preferences),
    });
    return Promise.resolve(true);
  }

  update(accountId: string, changes: ProfileChanges): Promise<boolean> {
    const row = this.rows.get(accountId);
    if (!row) return Promise.resolve(false);
    Object.assign(row.profile, changes.fields);
    if (changes.prompts) row.profile.prompts = structuredClone(changes.prompts);
    if (changes.interests) row.profile.interests = [...changes.interests];
    return Promise.resolve(true);
  }

  setPreferences(accountId: string, prefs: PreferencesRecord): Promise<boolean> {
    const row = this.rows.get(accountId);
    if (!row) return Promise.resolve(false);
    row.preferences = structuredClone(prefs);
    return Promise.resolve(true);
  }
}
