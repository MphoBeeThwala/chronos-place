/**
 * Prompt questions and interests members choose from (ADR-0023, decisions c and d). DRAFT copy for
 * the product owner to edit. Rules for this list:
 * - Nothing about health, diagnosis, treatment or the body. Health details belong only in the
 *   health profile (Health Vault), shared on the member's terms.
 * - Ids are stable: stored with members' answers. To retire an item, remove it from the list;
 *   answers that use it stop being shown. Never reuse an id for a different question.
 */
export const PROMPTS = [
  { id: 'perfect-sunday', question: 'My perfect Sunday looks like…' },
  { id: 'laugh', question: 'The quickest way to make me laugh is…' },
  { id: 'proud-of', question: 'Something I am quietly proud of…' },
  { id: 'looking-for', question: 'I am looking for someone who…' },
  { id: 'green-flag', question: 'A green flag I look out for…' },
  { id: 'comfort-food', question: 'My comfort food is…' },
  { id: 'learning', question: 'Something I am learning at the moment…' },
  { id: 'first-date', question: 'My idea of a good first date…' },
  { id: 'local-spot', question: 'A local spot I love…' },
  { id: 'small-joy', question: 'A small thing that makes my day…' },
] as const;

export const INTERESTS = [
  { id: 'hiking', label: 'Hiking' },
  { id: 'walking', label: 'Walks' },
  { id: 'cooking', label: 'Cooking' },
  { id: 'baking', label: 'Baking' },
  { id: 'braai', label: 'Braai' },
  { id: 'coffee', label: 'Coffee' },
  { id: 'reading', label: 'Reading' },
  { id: 'writing', label: 'Writing' },
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'film', label: 'Film' },
  { id: 'series', label: 'Series' },
  { id: 'music-live', label: 'Live music' },
  { id: 'amapiano', label: 'Amapiano' },
  { id: 'jazz', label: 'Jazz' },
  { id: 'gospel', label: 'Gospel' },
  { id: 'dancing', label: 'Dancing' },
  { id: 'art', label: 'Art' },
  { id: 'photography', label: 'Photography' },
  { id: 'gardening', label: 'Gardening' },
  { id: 'travel', label: 'Travel' },
  { id: 'road-trips', label: 'Road trips' },
  { id: 'nature', label: 'Nature' },
  { id: 'beach', label: 'Beach' },
  { id: 'soccer', label: 'Soccer' },
  { id: 'rugby', label: 'Rugby' },
  { id: 'cricket', label: 'Cricket' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'board-games', label: 'Board games' },
  { id: 'volunteering', label: 'Volunteering' },
  { id: 'faith', label: 'Faith' },
  { id: 'pets', label: 'Pets' },
  { id: 'fashion', label: 'Fashion' },
  { id: 'tech', label: 'Tech' },
  { id: 'languages', label: 'Languages' },
  { id: 'meditation', label: 'Meditation' },
] as const;

export type PromptId = (typeof PROMPTS)[number]['id'];
export type InterestId = (typeof INTERESTS)[number]['id'];

const PROMPT_IDS = new Set<string>(PROMPTS.map((p) => p.id));
const INTEREST_IDS = new Set<string>(INTERESTS.map((i) => i.id));

export const isPromptId = (id: string): id is PromptId => PROMPT_IDS.has(id);
export const isInterestId = (id: string): id is InterestId => INTEREST_IDS.has(id);
