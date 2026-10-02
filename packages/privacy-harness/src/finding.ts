import type { Marker, MarkerKind } from './markers.js';

export type FindingType = 'marker' | 'unredacted-field' | 'policy';

/** One leak found in one sink. */
export interface Finding {
  sink: string;
  type: FindingType;
  /** Set for marker findings. */
  markerKind?: MarkerKind;
  marker?: Marker;
  /** The encoding that matched, for marker findings. */
  form?: string;
  /** What went wrong, in a sentence. */
  detail: string;
  /** A short excerpt of the sink output around the match. */
  excerpt?: string;
}

/** Thrown by `assertClean`. The message lists every finding and the seed that reproduces the run. */
export class PrivacyLeakError extends Error {
  readonly findings: readonly Finding[];
  readonly seed: string;

  constructor(findings: readonly Finding[], seed: string) {
    const lines = findings.map(
      (f) =>
        `  [${f.sink}] ${f.type}${f.markerKind ? ` (${f.markerKind})` : ''}: ${f.detail}${f.excerpt ? `\n      …${f.excerpt}…` : ''}`,
    );
    super(
      `Privacy leak: ${String(findings.length)} finding(s). Reproduce with PRIVACY_SEED=${seed}\n${lines.join('\n')}`,
    );
    this.name = 'PrivacyLeakError';
    this.findings = findings;
    this.seed = seed;
  }
}
