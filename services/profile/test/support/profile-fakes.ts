import type { BlockVisibility } from '../../src/matching/visibility.js';
import type { MemberFact, MemberFacts } from '../../src/identity/member-facts.js';
import type { Point } from '../../src/profiles/location.js';
import type {
  OwnProfileRecord,
  PreferencesRecord,
  ProfileChanges,
  ProfileFields,
  ProfileStore,
  PromptAnswer,
  PublicProfileRecord,
  CandidateRow,
  CandidateViewer,
} from '../../src/profiles/profile-store.js';

/** Great-circle distance in metres, close to PostGIS geography distance for these tests. */
export function haversineMeters(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

/** Identity's member facts, from a map tests fill in. */
export class FakeMemberFacts implements MemberFacts {
  readonly facts = new Map<string, MemberFact>();
  readonly requested: string[][] = [];

  get(
    ids: readonly string[],
    options: { activity?: boolean } = {},
  ): Promise<Map<string, MemberFact>> {
    this.requested.push([...ids]);
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const fact = this.facts.get(id);
          if (!fact) return [];
          const { activity, ...rest } = fact;
          // Like identity: activity only when asked for.
          return [
            [id, options.activity === true && activity ? { ...rest, activity } : rest] as const,
          ];
        }),
      ),
    );
  }

  close(): void {
    // nothing to close
  }
}

/** Same rules as DrizzleProfileStore, in memory. */
export class InMemoryProfileStore implements ProfileStore {
  readonly rows = new Map<string, OwnProfileRecord>();
  /** When each profile was created, for newness; defaults to now. */
  readonly createdAt = new Map<string, Date>();
  /** Stored (already snapped) points, as the database would hold them. */
  readonly locations = new Map<string, Point>();

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

  setLocation(accountId: string, point: Point | null): Promise<boolean> {
    const row = this.rows.get(accountId);
    if (!row) return Promise.resolve(false);
    if (point) this.locations.set(accountId, { ...point });
    else this.locations.delete(accountId);
    row.profile.hasLocation = point !== null;
    return Promise.resolve(true);
  }

  publicProfiles(viewerId: string, ids: readonly string[]): Promise<PublicProfileRecord[]> {
    const from = this.locations.get(viewerId);
    return Promise.resolve(
      ids.flatMap((id) => {
        const row = this.rows.get(id);
        if (!row || id === viewerId || !row.profile.visible) return [];
        const to = this.locations.get(id);
        const p = row.profile;
        return [
          {
            accountId: id,
            displayName: p.displayName,
            bio: p.bio,
            intent: p.intent,
            gender: p.gender,
            pronouns: p.pronouns,
            areaLabel: p.areaLabel,
            distanceMeters: from && to ? haversineMeters(from, to) : null,
            privateMode: p.privateMode,
            prompts: structuredClone(p.prompts),
            interests: [...p.interests],
          },
        ];
      }),
    );
  }

  candidateViewer(viewerId: string): Promise<CandidateViewer | undefined> {
    const row = this.rows.get(viewerId);
    return Promise.resolve(
      row && {
        hasLocation: this.locations.has(viewerId),
        ageMin: row.preferences.ageMin,
        ageMax: row.preferences.ageMax,
      },
    );
  }

  candidates(
    viewerId: string,
    viewerAge: number,
    limit: number,
    after?: { distanceMeters: number; accountId: string },
    now: Date = new Date(),
  ): Promise<CandidateRow[]> {
    const viewer = this.rows.get(viewerId);
    const from = this.locations.get(viewerId);
    if (!viewer || !from) return Promise.resolve([]);
    const v = viewer.preferences;
    const rows = [...this.rows.values()].flatMap(({ profile: c, preferences: cp }) => {
      const to = this.locations.get(c.accountId);
      if (c.accountId === viewerId || !c.visible || !to) return [];
      const d = haversineMeters(from, to);
      const fits =
        d <= v.maxDistanceKm * 1000 &&
        (v.intents.length === 0 || v.intents.includes(c.intent)) &&
        (v.genders.length === 0 || (c.gender !== null && v.genders.includes(c.gender))) &&
        (cp.genders.length === 0 ||
          (viewer.profile.gender !== null && cp.genders.includes(viewer.profile.gender))) &&
        cp.ageMin <= viewerAge &&
        cp.ageMax >= viewerAge;
      if (!fits) return [];
      const createdAt = this.createdAt.get(c.accountId) ?? now;
      const signals = {
        closeness: Math.max(0, Math.min(100, Math.round(100 * (1 - d / (v.maxDistanceKm * 1000))))),
        mutualFit:
          (cp.intents.length === 0 || cp.intents.includes(viewer.profile.intent) ? 50 : 0) +
          (d <= cp.maxDistanceKm * 1000 ? 50 : 0),
        // Photos live in another store in these tests: the photo part is the SQL store's.
        completenessWithoutBadge:
          (c.bio ? 20 : 0) +
          Math.round((25 * Math.min(3, c.prompts.length)) / 3) +
          Math.round((10 * Math.min(3, c.interests.length)) / 3),
        newness: Math.max(
          0,
          Math.min(
            100,
            Math.round(100 * (1 - (now.getTime() - createdAt.getTime()) / (14 * 86_400_000))),
          ),
        ),
      };
      return [{ accountId: c.accountId, privateMode: c.privateMode, distanceMeters: d, signals }];
    });
    const key = (r: { distanceMeters: number; accountId: string }) =>
      [r.distanceMeters, r.accountId] as const;
    const before = (a: readonly [number, string], b: readonly [number, string]) =>
      a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    return Promise.resolve(
      rows
        .filter((r) => !after || before(key(after), key(r)))
        .sort((a, b) => (before(key(a), key(b)) ? -1 : 1))
        .slice(0, limit),
    );
  }
}

/** Matching's blocks, from pairs tests add (either order hides both). */
export class FakeBlocks implements BlockVisibility {
  readonly pairs = new Set<string>();
  static key = (a: string, b: string) => [a, b].sort().join(':');

  /** `from:to` likes, for private mode: a private member is seen only by members they liked. */
  readonly likes = new Set<string>();

  visibleTo(
    viewerId: string,
    ids: readonly string[],
    privateIds: readonly string[] = [],
  ): Promise<string[]> {
    return Promise.resolve(
      ids.filter(
        (id) =>
          !this.pairs.has(FakeBlocks.key(viewerId, id)) &&
          (!privateIds.includes(id) || this.likes.has(`${id}:${viewerId}`)),
      ),
    );
  }
}
