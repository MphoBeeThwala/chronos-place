import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { GatewayContext } from '../auth/context.js';
import { fromGrpc } from '../identity/errors.js';
import { toDate, type WireTimestamp } from '../identity/identity-client.js';
import type { MatchingClient } from '../matching/matching-client.js';
import type { ProfileClient } from '../profile/profile-client.js';
import type { ResolverMap } from './not-available.js';
import { promptQuestions, publicProfile, type WirePublicProfile } from './public-profile.js';

/** The most matches one page returns: as many as one profile lookup can name. */
export const MATCHES_PAGE_MAX = 50;

const SIGN_IN = () =>
  new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });
const INVALID = () =>
  new GraphQLError('Invalid input.', { extensions: { code: 'BAD_USER_INPUT' } });
const MATCH_NOT_FOUND = () =>
  new GraphQLError('That match was not found.', { extensions: { code: 'NOT_FOUND' } });

const inputs = {
  page: z.object({
    first: z.number().int().min(1).max(MATCHES_PAGE_MAX).nullish(),
    after: z.string().max(200).nullish(),
  }),
  account: z.object({ accountId: z.uuid() }),
  match: z.object({ matchId: z.uuid() }),
};

interface WireMatch {
  matchId: string;
  otherAccountId: string;
  createdAt: Date | WireTimestamp;
  cursor: string;
}

export interface MatchingResolverDeps {
  matching: MatchingClient;
  profile: ProfileClient;
}

/**
 * Likes, passes, matches and blocks (TASKS M3.1), served by the matching service. Another member's
 * profile only ever comes from the profile service, which leaves out anyone blocked either way.
 * Nothing here says whether someone blocked the member: liking someone you cannot see answers like
 * a like that did not match, and block and unblock always succeed.
 */
export function matchingResolvers(deps: MatchingResolverDeps): ResolverMap {
  const call = async <T>(method: string, request: object): Promise<T> => {
    try {
      return await deps.matching.call<T>(method, request);
    } catch (error) {
      throw fromGrpc(error, { notFound: MATCH_NOT_FOUND });
    }
  };
  const profileCall = async <T>(method: string, request: object): Promise<T> => {
    try {
      return await deps.profile.call<T>(method, request);
    } catch (error) {
      throw fromGrpc(error);
    }
  };
  const questions = promptQuestions(() => profileCall('getCatalogue', {}));
  const profilesFor = async (viewerAccountId: string, accountIds: string[]) => {
    if (accountIds.length === 0) return new Map<string, ReturnType<typeof publicProfile>>();
    const [{ profiles = [] }, prompts] = await Promise.all([
      profileCall<{ profiles?: WirePublicProfile[] }>('getPublicProfiles', {
        viewerAccountId,
        accountIds,
      }),
      questions(),
    ]);
    return new Map(profiles.map((p) => [p.accountId, publicProfile(p, prompts)]));
  };

  const viewerOf = (ctx: unknown): string => {
    const { viewer } = ctx as GatewayContext;
    if (!viewer) throw SIGN_IN();
    return viewer.accountId;
  };
  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
    const result = schema.safeParse(value);
    if (!result.success) throw INVALID();
    return result.data;
  };
  /** Another member's id: acting on yourself is invalid input. */
  const other = (args: unknown, self: string): string => {
    const { accountId } = parse(inputs.account, args);
    if (accountId === self) throw INVALID();
    return accountId;
  };

  return {
    Query: {
      matches: async (_parent, args, ctx) => {
        const accountId = viewerOf(ctx);
        const { first, after } = parse(inputs.page, args);
        const { matches = [], nextPageToken } = await call<{
          matches?: WireMatch[];
          nextPageToken: string;
        }>('listMatches', {
          accountId,
          pageSize: first ?? MATCHES_PAGE_MAX,
          pageToken: after ?? '',
        });
        const profiles = await profilesFor(
          accountId,
          matches.map((m) => m.otherAccountId),
        );
        return {
          // A match whose profile is paused, private or gone is left out of the list.
          edges: matches.flatMap((m) => {
            const profile = profiles.get(m.otherAccountId);
            return profile
              ? [
                  {
                    cursor: m.cursor,
                    node: { id: m.matchId, profile, matchedAt: toDate(m.createdAt) },
                  },
                ]
              : [];
          }),
          pageInfo: {
            endCursor: matches.at(-1)?.cursor ?? null,
            hasNextPage: nextPageToken !== '',
          },
        };
      },

      blockedMembers: async (_parent, _args, ctx) => {
        const accountId = viewerOf(ctx);
        const { blocked = [] } = await call<{
          blocked?: { accountId: string; blockedAt: Date | WireTimestamp }[];
        }>('listBlocked', { accountId });
        return blocked.map((b) => ({ accountId: b.accountId, blockedAt: toDate(b.blockedAt) }));
      },
    },

    Mutation: {
      like: async (_parent, args, ctx) => {
        const fromAccountId = viewerOf(ctx);
        const toAccountId = other(args, fromAccountId);
        const none = { matched: false, match: null };
        // Only someone the member can see: a blocked, paused or unknown member answers as no match.
        const profile = (await profilesFor(fromAccountId, [toAccountId])).get(toAccountId);
        if (!profile) return none;
        const result = await call<{ matched: boolean; matchId: string }>('like', {
          fromAccountId,
          toAccountId,
        });
        if (!result.matched) return none;
        const { match } = await call<{ match?: WireMatch }>('getMatch', {
          accountId: fromAccountId,
          matchId: result.matchId,
        });
        return {
          matched: true,
          match: match ? { id: match.matchId, profile, matchedAt: toDate(match.createdAt) } : null,
        };
      },

      pass: async (_parent, args, ctx) => {
        const fromAccountId = viewerOf(ctx);
        await call('pass', { fromAccountId, toAccountId: other(args, fromAccountId) });
        return true;
      },

      unmatch: async (_parent, args, ctx) => {
        const accountId = viewerOf(ctx);
        const { matchId } = parse(inputs.match, args);
        await call('unmatch', { accountId, matchId });
        return true;
      },

      block: async (_parent, args, ctx) => {
        const blockerAccountId = viewerOf(ctx);
        await call('block', { blockerAccountId, blockedAccountId: other(args, blockerAccountId) });
        return true;
      },

      unblock: async (_parent, args, ctx) => {
        const blockerAccountId = viewerOf(ctx);
        await call('unblock', {
          blockerAccountId,
          blockedAccountId: other(args, blockerAccountId),
        });
        return true;
      },
    },
  };
}
