import type {
  CandidateFilter,
  CandidatePage,
  CandidateSource,
  ConditionFilter,
  VaultAnswer,
} from '../../src/feed/sources.js';
import { DependencyUnavailable } from '../../src/feed/sources.js';
import type { RankingFeatures } from '../../src/feed/ranking.js';

/** Equal signals for everyone: the feed keeps profile's nearest-first order. */
export const NEUTRAL: RankingFeatures = {
  closeness: 50,
  activity: 50,
  mutualFit: 50,
  completeness: 50,
  newness: 50,
};

/** Profile's candidates, as pages tests set up. Tokens are the page index. */
export class FakeSource implements CandidateSource {
  pages: CandidatePage[] = [];
  calls = 0;
  down = false;

  page(_viewerId: string, pageToken: string): Promise<CandidatePage> {
    this.calls += 1;
    if (this.down) return Promise.reject(new DependencyUnavailable());
    const index = pageToken === '' ? 0 : Number(pageToken);
    const page = this.pages[index] ?? { outcome: 'ok', candidates: [], nextPageToken: '' };
    return Promise.resolve(page);
  }

  /** One OK page per list; each links to the next. */
  set(
    ...lists: { accountId: string; privateMode?: boolean; features?: RankingFeatures }[][]
  ): void {
    this.pages = lists.map((list, i) => ({
      outcome: 'ok',
      candidates: list.map((c) => ({
        accountId: c.accountId,
        privateMode: c.privateMode ?? false,
        features: c.features ?? NEUTRAL,
      })),
      nextPageToken: i + 1 < lists.length ? String(i + 1) : '',
    }));
  }
}

/** Matching's FilterCandidates: hides ids in `hidden`, and private ids not in `likedViewer`. */
export class FakeFilter implements CandidateFilter {
  readonly hidden = new Set<string>();
  readonly likedViewer = new Set<string>();
  readonly requests: { ids: string[]; privateIds: string[] }[] = [];
  down = false;

  filter(
    _viewerId: string,
    ids: readonly string[],
    privateIds: readonly string[],
  ): Promise<string[]> {
    this.requests.push({ ids: [...ids], privateIds: [...privateIds] });
    if (this.down) return Promise.reject(new DependencyUnavailable());
    return Promise.resolve(
      ids.filter(
        (id) => !this.hidden.has(id) && (!privateIds.includes(id) || this.likedViewer.has(id)),
      ),
    );
  }
}

let n = 0;
export const member = () => `99999999-9999-4999-8999-${String((n += 1)).padStart(12, '0')}`;
export const VIEWER = '99999999-9999-4999-8999-999999999999';

/**
 * The vault's condition filter: `no_preferences` unless a test says otherwise. With `matching`
 * set, behaves like the vault: those ids pass, and fewer than 20 passing gives nothing.
 */
export class FakeConditions implements ConditionFilter {
  answer: VaultAnswer['outcome'] | 'down' = 'no_preferences';
  readonly matching = new Set<string>();
  readonly requests: string[][] = [];

  eligible(_viewerId: string, ids: readonly string[]): Promise<VaultAnswer> {
    this.requests.push([...ids]);
    if (this.answer === 'down') return Promise.reject(new DependencyUnavailable());
    if (this.answer !== 'ok') return Promise.resolve({ outcome: this.answer });
    const eligible = ids.filter((id) => this.matching.has(id));
    return Promise.resolve(
      eligible.length >= 20 ? { outcome: 'ok', eligible } : { outcome: 'below_threshold' },
    );
  }
}
