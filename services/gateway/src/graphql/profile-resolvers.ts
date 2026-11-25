import { Intent } from '@chronos/contracts/profile';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { GatewayContext } from '../auth/context.js';
import type { AccountInfo } from '../auth/guard.js';
import { fromGrpc } from '../identity/errors.js';
import type { ProfileClient } from '../profile/profile-client.js';
import type { ResolverMap } from './not-available.js';

/** How long the prompt and interest catalogue is cached. It changes only with a deploy. */
export const CATALOGUE_TTL_MS = 10 * 60 * 1000;

const INTENT_TO_WIRE: Record<string, Intent> = {
  LONG_TERM: Intent.INTENT_LONG_TERM,
  DATING: Intent.INTENT_DATING,
  FRIENDSHIP: Intent.INTENT_FRIENDSHIP,
  OPEN: Intent.INTENT_OPEN,
};
const INTENT_FROM_WIRE = new Map<number, string>(
  Object.entries(INTENT_TO_WIRE).map(([name, value]) => [value, name]),
);
const INTENTS = ['LONG_TERM', 'DATING', 'FRIENDSHIP', 'OPEN'] as const;

const SIGN_IN = () =>
  new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });
const INVALID = () =>
  new GraphQLError('Invalid input.', { extensions: { code: 'BAD_USER_INPUT' } });
const PROFILE_REQUIRED = () =>
  new GraphQLError('Create your profile first.', { extensions: { code: 'PROFILE_REQUIRED' } });

// Validated at the edge (CLAUDE.md). Caps here only stop oversized input early; the profile
// service applies the real limits and owns the messages.
const text = z.string().max(2_000);
const inputs = {
  profile: z
    .object({
      displayName: text.nullish(),
      bio: text.nullish(),
      intent: z.enum(INTENTS).nullish(),
      gender: text.nullish(),
      pronouns: text.nullish(),
      areaLabel: text.nullish(),
      location: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
      clearLocation: z.boolean().nullish(),
      privateMode: z.boolean().nullish(),
      visible: z.boolean().nullish(),
      prompts: z
        .array(z.object({ promptId: z.string().max(64), answer: text }))
        .max(10)
        .nullish(),
      interests: z.array(z.string().max(64)).max(20).nullish(),
    })
    .refine((v) => !(v.location && v.clearLocation === true)),
  preferences: z.object({
    ageMin: z.number().int().nullish(),
    ageMax: z.number().int().nullish(),
    maxDistanceKm: z.number().int().nullish(),
    intents: z.array(z.enum(INTENTS)).max(10).nullish(),
    genders: z.array(z.string().max(200)).max(20).nullish(),
  }),
};

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw INVALID();
  return result.data;
}

interface WireProfile {
  accountId: string;
  displayName: string;
  bio: string;
  intent: number;
  gender: string;
  pronouns: string;
  areaLabel: string;
  privateMode: boolean;
  visible: boolean;
  prompts?: { promptId: string; answer: string }[];
  interests?: string[];
  hasLocation: boolean;
}
interface WirePreferences {
  ageMin: number;
  ageMax: number;
  maxDistanceKm: number;
  intents?: number[];
  genders?: string[];
}
interface WireOwn {
  profile: WireProfile;
  preferences: WirePreferences;
}
interface Catalogue {
  prompts: { id: string; question: string }[];
  interests: { id: string; label: string }[];
}

const orNull = (value: string) => (value === '' ? null : value);

export interface ProfileResolverDeps {
  profile: ProfileClient;
  accountInfo: (accountId: string) => Promise<AccountInfo>;
}

/**
 * The member's own profile (TASKS M1.5, ADR-0023), served by the profile service. Other members'
 * profiles (`profile`, `feed`) stay closed until matching can apply blocks (M3).
 */
export function profileResolvers(deps: ProfileResolverDeps): ResolverMap {
  const call = async <T>(method: string, request: object): Promise<T> => {
    try {
      return await deps.profile.call<T>(method, request);
    } catch (error) {
      throw fromGrpc(error, { notFound: PROFILE_REQUIRED });
    }
  };

  let cached: { catalogue: Catalogue; at: number } | undefined;
  const catalogue = async (): Promise<Catalogue> => {
    if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.catalogue;
    const result = await call<Partial<Catalogue>>('getCatalogue', {});
    const fresh = { prompts: result.prompts ?? [], interests: result.interests ?? [] };
    cached = { catalogue: fresh, at: Date.now() };
    return fresh;
  };

  const viewerOf = (ctx: GatewayContext) => {
    if (!ctx.viewer) throw SIGN_IN();
    return ctx.viewer;
  };

  /** The client's `Me`. Prompts and interests no longer in the catalogue are not shown. */
  const me = async (accountId: string, own: WireOwn) => {
    const [{ prompts, interests }, info] = await Promise.all([
      catalogue(),
      deps.accountInfo(accountId),
    ]);
    const questions = new Map(prompts.map((p) => [p.id, p.question]));
    const labels = new Map(interests.map((i) => [i.id, i.label]));
    const p = own.profile;
    return {
      id: p.accountId,
      displayName: p.displayName,
      bio: orNull(p.bio),
      intent: INTENT_FROM_WIRE.get(p.intent) ?? 'OPEN',
      gender: orNull(p.gender),
      pronouns: orNull(p.pronouns),
      areaLabel: orNull(p.areaLabel),
      privateMode: p.privateMode,
      visible: p.visible,
      verified: info.verified,
      // Photos arrive with M1.6; tiers with payments (M6).
      photos: [],
      prompts: (p.prompts ?? []).flatMap((a) => {
        const question = questions.get(a.promptId);
        return question ? [{ id: a.promptId, question, answer: a.answer }] : [];
      }),
      interests: (p.interests ?? []).flatMap((id) => {
        const label = labels.get(id);
        return label ? [{ id, label }] : [];
      }),
      sharesDistance: p.hasLocation,
      preferences: {
        ageMin: own.preferences.ageMin,
        ageMax: own.preferences.ageMax,
        maxDistanceKm: own.preferences.maxDistanceKm,
        intents: (own.preferences.intents ?? []).flatMap((i) => {
          const name = INTENT_FROM_WIRE.get(i);
          return name ? [name] : [];
        }),
        genders: own.preferences.genders ?? [],
      },
      tier: 'FREE',
    };
  };

  return {
    Query: {
      me: async (_parent, _args, ctx) => {
        const { accountId } = viewerOf(ctx as GatewayContext);
        return me(accountId, await call<WireOwn>('getOwnProfile', { accountId }));
      },
      profileCatalogue: () => catalogue(),
    },
    Mutation: {
      updateProfile: async (_parent, args, ctx) => {
        const { accountId } = viewerOf(ctx as GatewayContext);
        const { location, clearLocation, intent, prompts, interests, ...fields } = parse(
          inputs.profile,
          (args as { input?: unknown }).input,
        );
        // proto3 `optional`: a field left out of the request keeps its value.
        const request: Record<string, unknown> = { accountId };
        for (const [key, value] of Object.entries(fields)) {
          if (value !== null && value !== undefined) request[key] = value;
        }
        if (intent) request['intent'] = INTENT_TO_WIRE[intent];
        if (prompts) request['prompts'] = { items: prompts };
        if (interests) request['interests'] = { ids: interests };
        let own = await call<WireOwn>('updateProfile', request);
        if (location) {
          own = await call<WireOwn>('setLocation', { accountId, ...location });
        } else if (clearLocation === true) {
          own = await call<WireOwn>('setLocation', { accountId, clear: true });
        }
        return me(accountId, own);
      },
      updatePreferences: async (_parent, args, ctx) => {
        const { accountId } = viewerOf(ctx as GatewayContext);
        const { intents, genders, ...numbers } = parse(
          inputs.preferences,
          (args as { input?: unknown }).input,
        );
        const request: Record<string, unknown> = { accountId };
        for (const [key, value] of Object.entries(numbers)) {
          if (value !== null && value !== undefined) request[key] = value;
        }
        if (intents) request['intents'] = { values: intents.map((i) => INTENT_TO_WIRE[i]) };
        if (genders) request['genders'] = { values: genders };
        return me(accountId, await call<WireOwn>('updatePreferences', request));
      },
    },
  };
}
