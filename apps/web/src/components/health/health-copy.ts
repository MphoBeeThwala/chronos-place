/**
 * Member-facing wording for the health profile page (TASKS M2.8), approved 2026-11-26.
 * Person-first, stigma-free language (CLAUDE.md). Change only with the product owner's approval.
 */
import type { ConditionStatus, HealthVisibility } from '@chronos/contracts/graphql/types';

export const COPY = {
  heading: 'Your health profile',
  intro:
    "Only you decide who sees this. It's encrypted, and it never appears anywhere else on Chronos Place unless you choose.",
  conditions:
    "Add the conditions you'd like to share. For each one, choose Living with, In remission or Survivor.",
  ownWords: 'In your own words (optional)',
  ownWordsHelp: 'Needed if you choose Other. Only people you share with in full can read this.',
  note: "Anything else you'd like to add (optional)",
  noteHelp: 'Needed if you choose Other. Only people you share with in full can read this.',
  saved: 'Saved.',
  conflict:
    "This was changed on another device, so we've loaded the latest version. Please check it and save again.",
  visibilityHeading: 'Who can see your health profile',
  filtersHeading: 'Find and be found by condition',
  filtersHelp:
    'Filter by condition, and let others who share the same way find you. Results only show when at least 20 people match, so nobody can be singled out.',
  viewersHeading: 'Who has seen your health profile',
  viewersEmpty: 'Nobody has seen your health profile yet.',
  hiddenViewer: "A member you can't see right now",
} as const;

export const STATUS_LABELS: Record<ConditionStatus, string> = {
  LIVING_WITH: 'Living with',
  IN_REMISSION: 'In remission',
  SURVIVOR: 'Survivor',
};

export const VISIBILITY_OPTIONS: readonly {
  value: HealthVisibility;
  label: string;
  description: string;
}[] = [
  { value: 'HIDDEN', label: 'Only me', description: 'Nobody else can see it.' },
  {
    value: 'MATCH_ONLY',
    label: 'My matches',
    description: "People you've matched with see your conditions. Your own words stay private.",
  },
  {
    value: 'CHAT_GRANT',
    label: 'Only people I choose',
    description:
      'Nobody sees it until you share it with a match. You can take it back at any time.',
  },
  {
    value: 'PROFILE',
    label: 'All verified members',
    description: 'Verified members see your conditions. Your own words stay private.',
  },
];

export const OTHER_CODE = 'other';
export const MAX_CONDITIONS = 10;
export const MAX_TEXT = 500;

/** "Thandi, last viewed 3 Nov, 2 times, still shared" (approved wording). */
export function viewerLine(viewer: {
  name: string | null;
  lastViewedAt: string;
  viewCount: number;
  hasActiveGrant: boolean;
}): string {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Johannesburg',
  }).formatToParts(new Date(viewer.lastViewedAt));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // "3 Nov": the day without a leading zero, whatever the locale data pads.
  const date = `${String(Number(part('day')))} ${part('month')}`;
  const times = viewer.viewCount === 1 ? '1 time' : `${String(viewer.viewCount)} times`;
  return [
    viewer.name ?? COPY.hiddenViewer,
    `last viewed ${date}`,
    times,
    viewer.hasActiveGrant ? 'still shared' : 'not shared',
  ].join(', ');
}

/** Whether a draft can be saved; the Disclosure Service checks the same rules again. */
export function canSave(draft: {
  conditions: readonly { code: string }[];
  freeText: string;
  note: string;
}): boolean {
  const codes = draft.conditions.map((c) => c.code);
  return (
    codes.length <= MAX_CONDITIONS &&
    new Set(codes).size === codes.length &&
    draft.freeText.length <= MAX_TEXT &&
    draft.note.length <= MAX_TEXT &&
    (!codes.includes(OTHER_CODE) || draft.freeText.trim().length > 0)
  );
}
