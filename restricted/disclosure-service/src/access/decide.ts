/**
 * The access decision (TECHNICAL_SPEC 4.2): may `viewer` see `subject`'s health information?
 * Pure: every fact is gathered first, so each branch is tested from a table (M2.3 AC: 100% branch
 * coverage). Every decision, allow or deny, is written to the access log with `reason`; the caller
 * only ever learns allowed or not.
 *
 * M2.3 decisions: views by anyone but the member are denied until the matching service can say
 * whether they are blocked or matched (M3.1); moderation is denied until M5 can prove an open
 * report; "matches only" and "everyone" show conditions only, and own words and the note are
 * shared only through a one-to-one grant with full scope.
 */
export type ViewPurpose = 'profile_view' | 'chat_card' | 'moderation';
export type Visibility = 'hidden' | 'match_only' | 'chat_grant' | 'profile';
export type Scope = 'full' | 'conditions_only';

export interface AccessFacts {
  viewerId: string;
  subjectId: string;
  purpose: ViewPurpose;
  /** The subject's setting; undefined when they have no health profile. */
  visibility: Visibility | undefined;
  /** From matching; `unavailable` until M3.1 or when it cannot be reached. */
  relationship: { blocked: boolean; activeMatch: boolean } | 'unavailable';
  /** From identity; `unavailable` when it cannot be reached. */
  members: { subjectActive: boolean; viewerVerified: boolean } | 'unavailable';
  /** The subject's live grant to this viewer, if any (vault). */
  grant: Scope | undefined;
}

export type Decision =
  { allow: true; scope: Scope; reason: string } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });

export function decide(f: AccessFacts): Decision {
  if (f.visibility === undefined) return deny('no_profile');
  if (f.viewerId === f.subjectId) return { allow: true, scope: 'full', reason: 'self' };
  if (f.relationship === 'unavailable') return deny('relationship_unavailable');
  if (f.relationship.blocked) return deny('blocked');
  if (f.members === 'unavailable') return deny('identity_unavailable');
  if (!f.members.subjectActive) return deny('inactive');
  if (f.purpose === 'moderation') return deny('moderation_unavailable');
  switch (f.visibility) {
    case 'hidden':
      return deny('hidden');
    case 'match_only':
      return f.relationship.activeMatch
        ? { allow: true, scope: 'conditions_only', reason: 'match' }
        : deny('no_match');
    case 'chat_grant':
      return f.grant === undefined
        ? deny('no_grant')
        : { allow: true, scope: f.grant, reason: 'grant' };
    case 'profile':
      return f.members.viewerVerified
        ? { allow: true, scope: 'conditions_only', reason: 'verified' }
        : deny('not_verified');
  }
}
