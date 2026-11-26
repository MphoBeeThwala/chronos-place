import { describe, expect, it } from 'vitest';
import { decide, type AccessFacts, type Decision } from '../src/access/decide.js';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const SUBJECT = '22222222-2222-4222-8222-222222222222';

/** Everything that would allow a view, so each row changes one fact. */
const base: AccessFacts = {
  viewerId: VIEWER,
  subjectId: SUBJECT,
  purpose: 'profile_view',
  visibility: 'profile',
  relationship: { blocked: false, activeMatch: true },
  members: { subjectActive: true, viewerVerified: true },
  grant: 'full',
};
const allow = (scope: 'full' | 'conditions_only', reason: string): Decision => ({
  allow: true,
  scope,
  reason,
});
const deny = (reason: string): Decision => ({ allow: false, reason });

describe('decide (TECHNICAL_SPEC 4.2)', () => {
  it.each<[string, Partial<AccessFacts>, Decision]>([
    // No profile: nothing to show, for anyone, the member included.
    ['no profile', { visibility: undefined }, deny('no_profile')],
    ['no profile, self', { visibility: undefined, viewerId: SUBJECT }, deny('no_profile')],
    // Self: always, full, whatever else is true.
    [
      'self, even hidden, blocked state unknown and identity down',
      {
        viewerId: SUBJECT,
        visibility: 'hidden',
        relationship: 'unavailable',
        members: 'unavailable',
      },
      allow('full', 'self'),
    ],
    // Fail closed when facts are missing.
    ['matching unavailable', { relationship: 'unavailable' }, deny('relationship_unavailable')],
    ['identity unavailable', { members: 'unavailable' }, deny('identity_unavailable')],
    // Blocks beat everything, either way round (matching reports both directions as one flag).
    ['blocked', { relationship: { blocked: true, activeMatch: true } }, deny('blocked')],
    [
      'blocked, checked before an inactive subject',
      {
        relationship: { blocked: true, activeMatch: true },
        members: { subjectActive: false, viewerVerified: true },
      },
      deny('blocked'),
    ],
    [
      'inactive subject',
      { members: { subjectActive: false, viewerVerified: true } },
      deny('inactive'),
    ],
    // Moderation: denied until M5 can prove an open report, whatever the setting.
    ['moderation', { purpose: 'moderation' }, deny('moderation_unavailable')],
    [
      'moderation of a hidden profile',
      { purpose: 'moderation', visibility: 'hidden' },
      deny('moderation_unavailable'),
    ],
    // The member's setting.
    ['hidden', { visibility: 'hidden' }, deny('hidden')],
    ['matches only, matched', { visibility: 'match_only' }, allow('conditions_only', 'match')],
    [
      'matches only, not matched',
      { visibility: 'match_only', relationship: { blocked: false, activeMatch: false } },
      deny('no_match'),
    ],
    ['one-to-one, full grant', { visibility: 'chat_grant', grant: 'full' }, allow('full', 'grant')],
    [
      'one-to-one, conditions-only grant',
      { visibility: 'chat_grant', grant: 'conditions_only' },
      allow('conditions_only', 'grant'),
    ],
    ['one-to-one, no grant', { visibility: 'chat_grant', grant: undefined }, deny('no_grant')],
    [
      'one-to-one, grant but the match has ended (M3.1)',
      {
        visibility: 'chat_grant',
        grant: 'full',
        relationship: { blocked: false, activeMatch: false },
      },
      deny('no_match'),
    ],
    [
      'one-to-one, matched but no grant',
      {
        visibility: 'chat_grant',
        grant: undefined,
        relationship: { blocked: false, activeMatch: true },
      },
      deny('no_grant'),
    ],
    ['everyone, verified viewer', {}, allow('conditions_only', 'verified')],
    ['everyone, chat card purpose', { purpose: 'chat_card' }, allow('conditions_only', 'verified')],
    [
      'everyone, unverified viewer',
      { members: { subjectActive: true, viewerVerified: false } },
      deny('not_verified'),
    ],
    [
      'a grant does not widen "everyone" beyond conditions',
      { grant: 'full' },
      allow('conditions_only', 'verified'),
    ],
  ])('%s', (_name, change, expected) => {
    expect(decide({ ...base, ...change })).toEqual(expected);
  });

  it('uses reason codes the access log accepts', () => {
    const reasons = [
      'no_profile',
      'relationship_unavailable',
      'identity_unavailable',
      'moderation_unavailable',
      'not_verified',
    ];
    for (const reason of reasons) expect(reason).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });
});
