import type { Logger } from '@chronos/logger';
import {
  grpcClientCredentials,
  type ReadinessRegistry,
  type ServiceConfig,
} from '@chronos/service-kit';
import { Redis } from 'ioredis';
import type { discoveryConfig } from './config.js';
import { type FeedCache, RedisFeedCache } from './feed/feed-cache.js';
import { FeedService } from './feed/feed.service.js';
import {
  type CandidateFilter,
  type CandidateSource,
  MatchingFilter,
  ProfileCandidates,
} from './feed/sources.js';

export type DiscoveryConfig = ServiceConfig<typeof discoveryConfig>;

export interface RuntimeOverrides {
  source?: CandidateSource;
  filter?: CandidateFilter;
  cache?: FeedCache;
}

export interface DiscoveryRuntime {
  feed: FeedService;
  close: () => Promise<void>;
}

export function createDiscoveryRuntime(
  config: DiscoveryConfig,
  readiness: ReadinessRegistry,
  logger: Logger,
  overrides: RuntimeOverrides = {},
): DiscoveryRuntime {
  const redis =
    overrides.cache === undefined
      ? new Redis(config.REDIS_URL.reveal(), { maxRetriesPerRequest: 2 })
      : undefined;
  if (redis) {
    readiness.register('redis', async () => {
      await redis.ping();
    });
  }
  const source =
    overrides.source ??
    new ProfileCandidates(config.PROFILE_GRPC_ADDRESS, grpcClientCredentials(config, 'profile'));
  const filter =
    overrides.filter ??
    new MatchingFilter(config.MATCHING_GRPC_ADDRESS, grpcClientCredentials(config, 'matching'));
  const cache = overrides.cache ?? new RedisFeedCache(redis as Redis);
  return {
    feed: new FeedService({ source, filter, cache, logger }),
    close: async () => {
      source.close?.();
      filter.close?.();
      await redis?.quit();
    },
  };
}
