import { FeedFilter, FeedOutcome } from '@chronos/contracts/discovery';
import { DomainError } from '@chronos/service-kit';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { z } from 'zod';
import type { DiscoveryRuntime } from './runtime.js';
import type { FilterState } from './feed/feed-cache.js';
import type { Outcome } from './feed/sources.js';

export const DISCOVERY_RUNTIME = Symbol('DISCOVERY_RUNTIME');

const SERVICE = 'DiscoveryService';
const INVALID = 'Invalid request.';

const OUTCOME: Record<Outcome, FeedOutcome> = {
  ok: FeedOutcome.FEED_OUTCOME_OK,
  no_profile: FeedOutcome.FEED_OUTCOME_NO_PROFILE,
  no_location: FeedOutcome.FEED_OUTCOME_NO_LOCATION,
};

const FILTER: Record<FilterState, FeedFilter> = {
  off: FeedFilter.FEED_FILTER_OFF,
  on: FeedFilter.FEED_FILTER_ON,
  too_few_nearby: FeedFilter.FEED_FILTER_TOO_FEW_NEARBY,
  needs_your_sharing: FeedFilter.FEED_FILTER_NEEDS_YOUR_SHARING,
  unavailable: FeedFilter.FEED_FILTER_UNAVAILABLE,
};

// Validated at the edge (CLAUDE.md). Field names are the proto-loader camelCase.
const feed = z.object({
  viewerAccountId: z.uuid(),
  pageSize: z.number().int().min(0).max(50).default(0),
  pageToken: z.string().max(200).default(''),
});

/** chronos.discovery.v1.DiscoveryService (TASKS M3.2, ADR-0026). */
@Controller()
export class DiscoveryController {
  readonly #runtime: DiscoveryRuntime;

  constructor(@Inject(DISCOVERY_RUNTIME) runtime: DiscoveryRuntime) {
    this.#runtime = runtime;
  }

  @GrpcMethod(SERVICE, 'GetFeed')
  async getFeed(request: unknown): Promise<object> {
    const parsed = feed.safeParse(request);
    if (!parsed.success) throw new DomainError('invalid_argument', INVALID);
    const { viewerAccountId, pageSize, pageToken } = parsed.data;
    const page = await this.#runtime.feed.page(viewerAccountId, pageSize, pageToken);
    return {
      outcome: OUTCOME[page.outcome],
      accountIds: page.accountIds,
      nextPageToken: page.nextPageToken,
      filter: FILTER[page.filter],
    };
  }
}
