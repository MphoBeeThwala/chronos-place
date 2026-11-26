import { FeedOutcome } from '@chronos/contracts/discovery';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { GatewayContext } from '../auth/context.js';
import type { DiscoveryClient } from '../discovery/discovery-client.js';
import { fromGrpc } from '../identity/errors.js';
import type { ProfileClient } from '../profile/profile-client.js';
import type { ResolverMap } from './not-available.js';
import { profileLookup } from './public-profile.js';

export const FEED_PAGE_MAX = 50;

const SIGN_IN = () =>
  new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });
const INVALID = () =>
  new GraphQLError('Invalid input.', { extensions: { code: 'BAD_USER_INPUT' } });

const page = z.object({
  first: z.number().int().min(1).max(FEED_PAGE_MAX).nullish(),
  after: z.string().max(200).nullish(),
});

const STATUS = new Map<number, string>([
  [FeedOutcome.FEED_OUTCOME_OK, 'OK'],
  [FeedOutcome.FEED_OUTCOME_NO_PROFILE, 'PROFILE_REQUIRED'],
  [FeedOutcome.FEED_OUTCOME_NO_LOCATION, 'LOCATION_REQUIRED'],
]);

export interface DiscoveryResolverDeps {
  discovery: DiscoveryClient;
  profile: ProfileClient;
}

/**
 * The feed (TASKS M3.2, ADR-0026). Discovery decides who and in what order, by id; the cards come
 * from the profile service, which applies blocks, private mode and distance rounding once more.
 */
export function discoveryResolvers(deps: DiscoveryResolverDeps): ResolverMap {
  const profilesFor = profileLookup(deps.profile);
  return {
    Query: {
      feed: async (_parent, args, ctx) => {
        const { viewer } = ctx as GatewayContext;
        if (!viewer) throw SIGN_IN();
        const parsed = page.safeParse(args);
        if (!parsed.success) throw INVALID();
        let result: { outcome: number; accountIds?: string[]; nextPageToken: string };
        try {
          result = await deps.discovery.call('getFeed', {
            viewerAccountId: viewer.accountId,
            pageSize: parsed.data.first ?? 20,
            pageToken: parsed.data.after ?? '',
          });
        } catch (error) {
          throw fromGrpc(error);
        }
        const ids = result.accountIds ?? [];
        const profiles = await profilesFor(viewer.accountId, ids);
        const next = result.nextPageToken === '' ? null : result.nextPageToken;
        return {
          // Anything unknown is treated as nothing to show yet.
          status: STATUS.get(result.outcome) ?? 'OK',
          // The feed is paged with pageInfo.endCursor; every edge carries it.
          edges: ids.flatMap((id) => {
            const node = profiles.get(id);
            return node ? [{ cursor: next ?? '', node }] : [];
          }),
          pageInfo: { endCursor: next, hasNextPage: next !== null },
        };
      },
    },
  };
}
