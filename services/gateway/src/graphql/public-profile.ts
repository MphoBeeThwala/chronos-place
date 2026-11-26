import { photo } from './profile-resolvers.js';

/** Another member's profile as the profile service sends it (GetPublicProfiles). */
export interface WirePublicProfile {
  accountId: string;
  displayName: string;
  age: number;
  bio: string;
  areaLabel: string;
  distanceKm?: number | null;
  prompts?: { promptId: string; answer: string }[];
  verified: boolean;
  photos?: Parameters<typeof photo>[0][];
}

const text = (value: string | undefined) => (value === undefined || value === '' ? null : value);

/** The client's `PublicProfile`. Prompts no longer in the catalogue are not shown. */
export const publicProfile = (p: WirePublicProfile, questions: Map<string, string>) => ({
  id: p.accountId,
  displayName: p.displayName,
  age: p.age,
  bio: text(p.bio),
  areaLabel: text(p.areaLabel),
  distanceKm: p.distanceKm ?? null,
  photos: (p.photos ?? []).map(photo),
  prompts: (p.prompts ?? []).flatMap((answer) => {
    const question = questions.get(answer.promptId);
    return question === undefined ? [] : [{ id: answer.promptId, question, answer: answer.answer }];
  }),
  verified: p.verified,
});

/** How long prompt questions are cached. They change only with a deploy. */
export const QUESTIONS_TTL_MS = 10 * 60 * 1000;

/** Prompt questions by id, from the profile catalogue, cached. */
export function promptQuestions(
  fetch: () => Promise<{ prompts?: { id: string; question: string }[] }>,
): () => Promise<Map<string, string>> {
  let cached: { questions: Map<string, string>; at: number } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < QUESTIONS_TTL_MS) return cached.questions;
    const result = await fetch();
    cached = {
      questions: new Map((result.prompts ?? []).map((p) => [p.id, p.question])),
      at: Date.now(),
    };
    return cached.questions;
  };
}
