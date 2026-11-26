/** Block and match state between two members, from the matching service (TECHNICAL_SPEC 4.2). */
export interface Relationships {
  between(
    viewerId: string,
    subjectId: string,
  ): Promise<{ blocked: boolean; activeMatch: boolean } | 'unavailable'>;
}

/**
 * Until the matching service exists (M3.1) nobody can say whether two members are blocked or
 * matched, so every view by someone other than the member is denied (M2.3 decision: fail closed).
 * M3.1 replaces this with a matching client that also answers `unavailable` when it cannot be
 * reached.
 */
export class MatchingNotYetAvailable implements Relationships {
  between(): Promise<'unavailable'> {
    return Promise.resolve('unavailable');
  }
}
