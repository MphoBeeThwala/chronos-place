/**
 * Ranking v1 (TASKS M3.3, ADR-0007, ADR-0027): rules-based and deterministic. Each candidate's score
 * is a weighted sum of five signals from 0 to 100. Health data is never a signal.
 */
export interface RankingFeatures {
  closeness: number;
  activity: number;
  mutualFit: number;
  completeness: number;
  newness: number;
}

/** Approved 2026-11-26 ("balanced"). Points out of 100; changing them is a product decision. */
export const RANKING_WEIGHTS: Readonly<RankingFeatures> = {
  closeness: 30,
  activity: 25,
  mutualFit: 20,
  completeness: 15,
  newness: 10,
};

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/** 0 to 100. A signal outside 0 to 100 is held to it, so one bad value cannot dominate. */
export function score(f: RankingFeatures, w: Readonly<RankingFeatures> = RANKING_WEIGHTS): number {
  return (
    (w.closeness * clamp(f.closeness) +
      w.activity * clamp(f.activity) +
      w.mutualFit * clamp(f.mutualFit) +
      w.completeness * clamp(f.completeness) +
      w.newness * clamp(f.newness)) /
    100
  );
}

/**
 * Highest score first. Equal scores keep the order given (nearest first), so the same candidates
 * always come out in the same order.
 */
export function rank<T extends { features: RankingFeatures }>(candidates: readonly T[]): T[] {
  return candidates
    .map((c, index) => ({ c, index, s: score(c.features) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map(({ c }) => c);
}
