import {
  ConditionStatus,
  GrantScope,
  Purpose,
  Visibility,
  type GetFilterPreferencesResponse,
  type GetOwnHealthProfileResponse,
  type ListConditionTaxonomyResponse,
  type ListHealthViewersResponse,
  type RevokeDisclosureResponse,
  type UpsertHealthProfileResponse,
  type ViewHealthProfileResponse,
} from '@chronos/contracts/disclosure';
import { status } from '@grpc/grpc-js';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { GatewayContext } from '../auth/context.js';
import type { DisclosureClient } from '../disclosure/disclosure-client.js';
import type { MatchingClient } from '../matching/matching-client.js';
import { fromGrpc } from '../identity/errors.js';
import { toDate } from '../identity/identity-client.js';
import type { RateLimiter } from '../limits/rate-limit.js';
import type { ProfileClient } from '../profile/profile-client.js';
import type { ResolverMap } from './not-available.js';
import { promptQuestions, publicProfile, type WirePublicProfile } from './public-profile.js';

/** The condition list holds no member data and changes only with a migration. */
export const TAXONOMY_TTL_MS = 10 * 60 * 1000;
/** `healthViewers` returns the most recent viewers, as many as one profile lookup can name. */
export const HEALTH_VIEWERS_LIMIT = 50;

const STATUS_TO_WIRE = {
  LIVING_WITH: ConditionStatus.CONDITION_STATUS_LIVING_WITH,
  IN_REMISSION: ConditionStatus.CONDITION_STATUS_IN_REMISSION,
  SURVIVOR: ConditionStatus.CONDITION_STATUS_SURVIVOR,
} as const;
const VISIBILITY_TO_WIRE = {
  HIDDEN: Visibility.VISIBILITY_HIDDEN,
  MATCH_ONLY: Visibility.VISIBILITY_MATCH_ONLY,
  CHAT_GRANT: Visibility.VISIBILITY_CHAT_GRANT,
  PROFILE: Visibility.VISIBILITY_PROFILE,
} as const;
const SCOPE_TO_WIRE = {
  FULL: GrantScope.GRANT_SCOPE_FULL,
  CONDITIONS_ONLY: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
} as const;
const SCOPE_FROM_WIRE = new Map<number, string>([
  [GrantScope.GRANT_SCOPE_FULL, 'FULL'],
  [GrantScope.GRANT_SCOPE_CONDITIONS_ONLY, 'CONDITIONS_ONLY'],
]);
const reverse = (map: Record<string, number>) =>
  new Map(Object.entries(map).map(([name, value]) => [value, name]));
const STATUS_FROM_WIRE = reverse(STATUS_TO_WIRE);
const VISIBILITY_FROM_WIRE = reverse(VISIBILITY_TO_WIRE);

/** The Disclosure Service's fixed messages (restricted/disclosure-service). Nothing else passes. */
const DISCLOSURE_MESSAGES = new Set([
  'Invalid request.',
  'Invalid health profile.',
  'Invalid filter preferences.',
  'Create your health profile first.',
  'You can share only with a current match.',
  'Health profile changed elsewhere; reload and try again.',
  'Sharing changed elsewhere; reload and try again.',
]);
const NOT_A_MATCH = 'You can share only with a current match.';
const CONFLICT_MESSAGE = 'Health profile changed elsewhere; reload and try again.';
const GENERIC: Partial<Record<number, string>> = {
  [status.INVALID_ARGUMENT]: 'Invalid input.',
  [status.FAILED_PRECONDITION]: 'That is not possible right now.',
};

const SIGN_IN = () =>
  new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });
const INVALID = () =>
  new GraphQLError('Invalid input.', { extensions: { code: 'BAD_USER_INPUT' } });

// Validated at the edge (CLAUDE.md). Caps here only stop oversized input early; the Disclosure
// Service applies the real rules and owns the (fixed) messages.
const code = z.string().max(40);
const inputs = {
  profile: z.object({
    conditions: z
      .array(z.object({ code, status: z.enum(['LIVING_WITH', 'IN_REMISSION', 'SURVIVOR']) }))
      .max(10),
    freeText: z.string().max(1_000).nullish(),
    note: z.string().max(1_000).nullish(),
    expectedVersion: z.number().int().min(0).nullish(),
  }),
  visibility: z.object({
    visibility: z.enum(['HIDDEN', 'MATCH_ONLY', 'CHAT_GRANT', 'PROFILE']),
    filterOptIn: z.boolean().nullish(),
  }),
  filters: z.object({ conditionCodes: z.array(code).max(10) }),
  account: z.object({ accountId: z.uuid() }),
  share: z.object({ matchId: z.uuid(), scope: z.enum(['FULL', 'CONDITIONS_ONLY']) }),
};

export interface HealthResolverDeps {
  disclosure: DisclosureClient;
  profile: ProfileClient;
  matching: MatchingClient;
  rateLimiter: Pick<RateLimiter, 'checkHealthRead' | 'checkHealthWrite'>;
}

/**
 * Health fields (TASKS M2.8), resolved only through the Disclosure Service (spec 6). Every one is
 * served with `Cache-Control: no-store`, and nothing from a response is logged or cached here.
 */
export function healthResolvers(deps: HealthResolverDeps): ResolverMap {
  const call = async <T>(method: string, request: object): Promise<T> => {
    try {
      return await deps.disclosure.call<T>(method, request);
    } catch (error) {
      const grpc = error as { code?: unknown; details?: unknown };
      const known = typeof grpc.details === 'string' && DISCLOSURE_MESSAGES.has(grpc.details);
      // A newer save from another device.
      if (grpc.code === status.ABORTED) {
        throw new GraphQLError(known ? String(grpc.details) : CONFLICT_MESSAGE, {
          extensions: { code: 'CONFLICT' },
        });
      }
      // Only the Disclosure Service's fixed messages reach the member; anything else, whatever
      // the code, is replaced, so no text from a health request can come back (rule 3).
      throw fromGrpc(known ? error : { code: grpc.code, details: GENERIC[Number(grpc.code)] });
    }
  };
  const profileCall = async <T>(method: string, request: object): Promise<T> => {
    try {
      return await deps.profile.call<T>(method, request);
    } catch (error) {
      throw fromGrpc(error);
    }
  };

  /** Signs in, marks the response no-store and counts the request. */
  const health = async (ctx: unknown, kind: 'read' | 'write'): Promise<string> => {
    const context = ctx as GatewayContext;
    if (!context.viewer) throw SIGN_IN();
    context.noStore = true;
    const { accountId } = context.viewer;
    await (kind === 'read'
      ? deps.rateLimiter.checkHealthRead(accountId)
      : deps.rateLimiter.checkHealthWrite(accountId));
    return accountId;
  };

  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
    const result = schema.safeParse(value);
    if (!result.success) throw INVALID();
    return result.data;
  };

  const conditions = (list: { code: string; status: number }[] | undefined) =>
    (list ?? []).flatMap((c) => {
      const name = STATUS_FROM_WIRE.get(c.status);
      return name === undefined ? [] : [{ code: c.code, status: name }];
    });
  const text = (value: string | undefined) => (value === undefined || value === '' ? null : value);

  const ownProfile = async (accountId: string) => {
    const { profile: own } = await call<GetOwnHealthProfileResponse>('getOwnHealthProfile', {
      accountId,
    });
    if (!own) return null;
    return {
      conditions: conditions(own.profile?.conditions),
      freeText: text(own.profile?.freeText),
      note: text(own.profile?.note),
      visibility: VISIBILITY_FROM_WIRE.get(own.visibility) ?? 'HIDDEN',
      filterOptIn: own.filterOptIn,
      version: own.version,
    };
  };

  let taxonomy: { entries: { code: string; label: string }[]; at: number } | undefined;
  const loadQuestions = promptQuestions(() => profileCall('getCatalogue', {}));

  return {
    Query: {
      myHealthProfile: async (_parent, _args, ctx) => ownProfile(await health(ctx, 'read')),

      healthProfileOf: async (_parent, args, ctx) => {
        const viewer = await health(ctx, 'read');
        const { accountId } = parse(inputs.account, args);
        const result = await call<ViewHealthProfileResponse>('viewHealthProfile', {
          viewerAccountId: viewer,
          subjectAccountId: accountId,
          purpose: Purpose.PURPOSE_PROFILE_VIEW,
        });
        if (!result.allowed || !result.profile) return null;
        return {
          conditions: conditions(result.profile.conditions),
          freeText: text(result.profile.freeText),
          note: text(result.profile.note),
          scope: SCOPE_FROM_WIRE.get(result.profile.scope) ?? 'CONDITIONS_ONLY',
          leaseExpiresAt: toDate(result.profile.leaseExpiresAt),
        };
      },

      healthViewers: async (_parent, _args, ctx) => {
        const accountId = await health(ctx, 'read');
        const { viewers } = await call<ListHealthViewersResponse>('listHealthViewers', {
          subjectAccountId: accountId,
          pageSize: HEALTH_VIEWERS_LIMIT,
        });
        if (viewers.length === 0) return [];
        const [{ profiles = [] }, questions] = await Promise.all([
          profileCall<{ profiles?: WirePublicProfile[] }>('getPublicProfiles', {
            viewerAccountId: accountId,
            accountIds: viewers.map((v) => v.viewerAccountId),
          }),
          loadQuestions(),
        ]);
        const byId = new Map(profiles.map((p) => [p.accountId, p]));
        return viewers.map((v) => {
          const p = byId.get(v.viewerAccountId);
          return {
            // Null when they have left, paused or are in private mode: the profile service does
            // not say which.
            viewer: p ? publicProfile(p, questions) : null,
            lastViewedAt: toDate(v.lastViewedAt),
            viewCount: v.viewCount,
            hasActiveGrant: v.hasActiveGrant,
          };
        });
      },

      conditionTaxonomy: async (_parent, _args, ctx) => {
        // No member data, but served from the health page: no-store all the same.
        const context = ctx as GatewayContext;
        if (!context.viewer) throw SIGN_IN();
        context.noStore = true;
        if (taxonomy && Date.now() - taxonomy.at < TAXONOMY_TTL_MS) return taxonomy.entries;
        const { entries } = await call<ListConditionTaxonomyResponse>('listConditionTaxonomy', {});
        taxonomy = {
          entries: entries.map((e) => ({ code: e.code, label: e.labelEn })),
          at: Date.now(),
        };
        return taxonomy.entries;
      },

      myHealthFilters: async (_parent, _args, ctx) => {
        const accountId = await health(ctx, 'read');
        const result = await call<GetFilterPreferencesResponse>('getFilterPreferences', {
          accountId,
        });
        return result.wantedConditionCodes;
      },
    },

    Mutation: {
      upsertHealthProfile: async (_parent, args, ctx) => {
        const accountId = await health(ctx, 'write');
        const input = parse(inputs.profile, (args as { input?: unknown }).input);
        await call<UpsertHealthProfileResponse>('upsertHealthProfile', {
          accountId,
          expectedVersion: input.expectedVersion ?? 0,
          profile: {
            conditions: input.conditions.map((c) => ({
              code: c.code,
              status: STATUS_TO_WIRE[c.status],
            })),
            ...(input.freeText ? { freeText: input.freeText } : {}),
            ...(input.note ? { note: input.note } : {}),
          },
        });
        return ownProfile(accountId);
      },

      setHealthVisibility: async (_parent, args, ctx) => {
        const accountId = await health(ctx, 'write');
        const input = parse(inputs.visibility, args);
        // Left out: keep the current opt-in.
        const filterOptIn =
          input.filterOptIn ?? (await ownProfile(accountId))?.filterOptIn ?? false;
        await call('setVisibility', {
          accountId,
          visibility: VISIBILITY_TO_WIRE[input.visibility],
          filterOptIn,
        });
        return ownProfile(accountId);
      },

      setHealthFilters: async (_parent, args, ctx) => {
        const accountId = await health(ctx, 'write');
        const { conditionCodes } = parse(inputs.filters, args);
        await call('setFilterPreferences', { accountId, wantedConditionCodes: conditionCodes });
        return conditionCodes;
      },

      revokeHealthShare: async (_parent, args, ctx) => {
        const subject = await health(ctx, 'write');
        const { accountId } = parse(inputs.account, args);
        const result = await call<RevokeDisclosureResponse>('revokeDisclosure', {
          subjectAccountId: subject,
          viewerAccountId: accountId,
        });
        return result.revoked;
      },

      shareHealthCard: async (_parent, args, ctx) => {
        const subject = await health(ctx, 'write');
        const { matchId, scope } = parse(inputs.share, args);
        // The card names the match; matching says who it is with, only for an active match of
        // the member's. Anything else reads exactly like the Disclosure Service's own refusal.
        let viewer: string | undefined;
        try {
          const { match } = await deps.matching.call<{ match?: { otherAccountId: string } }>(
            'getMatch',
            { accountId: subject, matchId },
          );
          viewer = match?.otherAccountId;
        } catch (error) {
          if ((error as { code?: unknown }).code !== status.NOT_FOUND) throw fromGrpc(error);
        }
        if (viewer === undefined || viewer === '') {
          throw new GraphQLError(NOT_A_MATCH, { extensions: { code: 'FAILED_PRECONDITION' } });
        }
        await call('grantDisclosure', {
          subjectAccountId: subject,
          viewerAccountId: viewer,
          scope: SCOPE_TO_WIRE[scope],
        });
        return true;
      },
    },
  };
}
