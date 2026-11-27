import type { Logger } from '@chronos/logger';
import {
  grpcClientCredentials,
  type ReadinessRegistry,
  type ServiceConfig,
} from '@chronos/service-kit';
import { Redis } from 'ioredis';
import type { discoveryConfig } from './config.js';
import { type FeedCache, MemoryFeedCache, RedisFeedCache } from './feed/feed-cache.js';
import { FeedService } from './feed/feed.service.js';
import {
  type CandidateFilter,
  type CandidateSource,
  type ConditionFilter,
  MatchingFilter,
  ProfileCandidates,
  VaultConditionFilter,
} from './feed/sources.js';

export type DiscoveryConfig = ServiceConfig<typeof discoveryConfig>;

export interface RuntimeOverrides {
  source?: CandidateSource;
  filter?: CandidateFilter;
  cache?: FeedCache;
  conditions?: ConditionFilter;
  memory?: FeedCache;
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
  const conditions =
    overrides.conditions ??
    new VaultConditionFilter(
      config.DISCLOSURE_GRPC_ADDRESS,
      grpcClientCredentials(config, 'disclosure-service'),
    );
  const memory = overrides.memory ?? new MemoryFeedCache();
  return {
    feed: new FeedService({ source, filter, cache, conditions, memory, logger }),
    close: async () => {
      source.close?.();
      filter.close?.();
      conditions.close?.();
      await redis?.quit();
    },
  };
}
