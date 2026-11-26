/**
 * Synthetic members (CLAUDE.md rule 6): deterministic from a seed, never real people or real data.
 * Every id starts with `5eed`, so seeded rows can be told apart and removed.
 */

/** Small, fast, deterministic PRNG (mulberry32). Not for anything security-related. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SEED_ID_PREFIX = '5eed';

/** A version-4 UUID whose first four hex digits are `5eed`. */
export function seededId(random: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[0] = 0x5e;
  bytes[1] = 0xed;
  bytes[6] = 0x40 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Where members live: South African metros by share of the 200,000 default, the rest rural. */
export const AREAS = [
  { name: 'Johannesburg', lat: -26.2, lng: 28.04, radiusKm: 25, members: 25_000 },
  { name: 'Ekurhuleni', lat: -26.15, lng: 28.3, radiusKm: 15, members: 15_000 },
  { name: 'Pretoria', lat: -25.75, lng: 28.19, radiusKm: 20, members: 15_000 },
  { name: 'Cape Town', lat: -33.92, lng: 18.42, radiusKm: 25, members: 25_000 },
  { name: 'Durban', lat: -29.86, lng: 31.02, radiusKm: 20, members: 20_000 },
  { name: 'Gqeberha', lat: -33.96, lng: 25.6, radiusKm: 12, members: 8_000 },
  { name: 'Bloemfontein', lat: -29.12, lng: 26.21, radiusKm: 10, members: 6_000 },
  { name: 'Pietermaritzburg', lat: -29.6, lng: 30.38, radiusKm: 10, members: 5_000 },
  { name: 'East London', lat: -33.02, lng: 27.91, radiusKm: 10, members: 5_000 },
  { name: 'Polokwane', lat: -23.9, lng: 29.45, radiusKm: 10, members: 5_000 },
  { name: 'Mbombela', lat: -25.47, lng: 30.97, radiusKm: 10, members: 4_000 },
  { name: 'Rustenburg', lat: -25.67, lng: 27.24, radiusKm: 10, members: 4_000 },
  { name: 'Kimberley', lat: -28.74, lng: 24.77, radiusKm: 8, members: 3_000 },
  { name: 'George', lat: -33.96, lng: 22.46, radiusKm: 8, members: 3_000 },
] as const;
const DEFAULT_TOTAL = 200_000;
/** Rural members fall anywhere in this box (roughly South Africa). */
const RURAL = { latMin: -34.5, latMax: -22.5, lngMin: 17, lngMax: 32.5 };

/** Stored points are snapped to a 0.01-degree grid, as the profile service does (ADR-0023). */
const snap = (degrees: number) => Math.round(degrees * 100) / 100;

export const INTENTS = ['long_term', 'dating', 'friendship', 'open'] as const;
const NAMES = [
  'Lerato',
  'Thabo',
  'Ayanda',
  'Sipho',
  'Naledi',
  'Bongani',
  'Zanele',
  'Kagiso',
  'Palesa',
  'Lwazi',
  'Anele',
  'Mpho',
  'Karabo',
  'Nandi',
  'Tumelo',
  'Asanda',
  'Jabu',
  'Refilwe',
  'Sizwe',
  'Tshepo',
  'Amahle',
  'Andile',
  'Lindiwe',
  'Kabelo',
  'Nomsa',
  'Pieter',
  'Annelie',
  'Riaan',
  'Fatima',
  'Yusuf',
  'Priya',
  'Sanjay',
  'Chloe',
  'Liam',
  'Thandi',
  'Neo',
];

export interface SeedMember {
  id: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  age: number;
  active: boolean;
  verified: boolean;
  displayName: string;
  intent: (typeof INTENTS)[number];
  gender: string | null;
  /** Null for members who have not shared a location. */
  point: { lat: number; lng: number } | null;
  area: string;
  visible: boolean;
  privateMode: boolean;
  prefs: {
    ageMin: number;
    ageMax: number;
    maxDistanceKm: number;
    intents: string[];
    genders: string[];
  };
}

export interface SeedDecision {
  fromId: string;
  toId: string;
  kind: 'like' | 'pass';
}

export interface SeedOptions {
  members?: number;
  seed?: number;
  /** The date ages are worked out from (South African calendar date). */
  today?: { year: number; month: number; day: number };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;
const weighted = <T>(random: () => number, items: readonly (readonly [T, number])[]): T => {
  let r = random() * items.reduce((sum, [, w]) => sum + w, 0);
  for (const [item, weight] of items) {
    r -= weight;
    if (r <= 0) return item;
  }
  return (items.at(-1) as readonly [T, number])[0];
};

/** A point within `radiusKm` of a centre, denser towards the middle. */
function near(random: () => number, lat: number, lng: number, radiusKm: number) {
  const distance = radiusKm * random() ** 0.75;
  const bearing = random() * 2 * Math.PI;
  const dLat = (distance / 111.32) * Math.cos(bearing);
  const dLng = (distance / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(bearing);
  return { lat: snap(lat + dLat), lng: snap(lng + dLng) };
}

/** Members spread over the areas in proportion, plus their likes and passes. Deterministic. */
export function generate(options: SeedOptions = {}): {
  members: SeedMember[];
  decisions: SeedDecision[];
} {
  const total = options.members ?? DEFAULT_TOTAL;
  const random = prng(options.seed ?? 20261126);
  const today = options.today ?? { year: 2026, month: 11, day: 26 };
  const scale = total / DEFAULT_TOTAL;
  const plan: { name: string; count: number; at?: (typeof AREAS)[number] }[] = AREAS.map((a) => ({
    name: a.name,
    count: Math.round(a.members * scale),
    at: a,
  }));
  const placed = plan.reduce((sum, p) => sum + p.count, 0);
  plan.push({ name: 'Rural', count: Math.max(0, total - placed) });

  const members: SeedMember[] = [];
  for (const area of plan) {
    for (let i = 0; i < area.count; i += 1) {
      // Ages 18 to 70, most between 25 and 45.
      const age = Math.min(70, 18 + Math.floor(-Math.log(1 - random() * 0.999) * 14));
      const month = 1 + Math.floor(random() * 12);
      const day = 1 + Math.floor(random() * 28);
      const hadBirthday = month < today.month || (month === today.month && day <= today.day);
      const year = today.year - age - (hadBirthday ? 0 : 1);
      const gender = weighted<string | null>(random, [
        ['woman', 48],
        ['man', 47],
        ['non-binary', 3],
        [null, 2],
      ]);
      const intent = weighted(random, [
        ['long_term', 40],
        ['dating', 35],
        ['friendship', 10],
        ['open', 15],
      ] as const);
      const wants =
        gender === 'woman' && random() < 0.85
          ? ['man']
          : gender === 'man' && random() < 0.85
            ? ['woman']
            : [];
      const spread = 5 + Math.floor(random() * 8);
      const point =
        random() < 0.05
          ? null
          : area.at
            ? near(random, area.at.lat, area.at.lng, area.at.radiusKm)
            : {
                lat: snap(RURAL.latMin + random() * (RURAL.latMax - RURAL.latMin)),
                lng: snap(RURAL.lngMin + random() * (RURAL.lngMax - RURAL.lngMin)),
              };
      members.push({
        id: seededId(random),
        dateOfBirth: `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        age,
        active: random() < 0.97,
        verified: random() < 0.55,
        displayName: pick(random, NAMES),
        intent,
        gender,
        point,
        area: area.name,
        visible: random() < 0.96,
        privateMode: random() < 0.05,
        prefs: {
          ageMin: Math.max(18, age - spread),
          ageMax: Math.min(99, age + spread + 3),
          maxDistanceKm: pick(random, [25, 50, 50, 50, 100, 150]),
          intents: random() < 0.7 ? [] : [intent],
          genders: wants,
        },
      });
    }
  }

  // One in ten members has liked or passed on about 30 others from their own area.
  const byArea = new Map<string, SeedMember[]>();
  for (const m of members) byArea.set(m.area, [...(byArea.get(m.area) ?? []), m]);
  const decisions: SeedDecision[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (random() >= 0.1) continue;
    const pool = byArea.get(m.area) ?? [];
    for (let i = 0; i < 30 && pool.length > 1; i += 1) {
      const other = pick(random, pool);
      const key = `${m.id}:${other.id}`;
      if (other.id === m.id || seen.has(key)) continue;
      seen.add(key);
      decisions.push({ fromId: m.id, toId: other.id, kind: random() < 0.6 ? 'like' : 'pass' });
    }
  }
  return { members, decisions };
}
