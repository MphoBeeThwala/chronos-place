import { flag, redisUrl, secret } from '@chronos/config';
import { z } from 'zod';

/** The gateway's own settings, merged with the kit's. */
export const gatewayConfig = {
  /** Refresh locks across replicas now; rate limits next (ADR-0021). */
  REDIS_URL: redisUrl,
  /** Base64, at least 32 bytes: keyed hashes of IP addresses in rate-limit keys. */
  RATE_LIMIT_HASH_KEY: secret(32),
  /**
   * The approved-operations manifest built from the web app (ADR-0021, decision b). Required
   * outside development: only operations listed there run.
   */
  PERSISTED_OPERATIONS_PATH: z.string().min(1).optional(),
  /** host:port of the identity service's gRPC API. */
  IDENTITY_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50052'),
  /** host:port of the profile service's gRPC API (ADR-0023). */
  PROFILE_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50053'),
  /**
   * Path the browser uses for GraphQL, behind the web app's same-origin rewrite (ADR-0017).
   * The refresh cookie is scoped to it, so it is not sent with page requests.
   */
  GRAPHQL_PUBLIC_PATH: z.string().startsWith('/').default('/api/graphql'),
  /** Mark cookies Secure. Only local HTTP development may turn this off. */
  COOKIE_SECURE: flag.default(true),
  /** Proxies in front of the gateway whose X-Forwarded-For entries are trusted (edge, web app). */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
};

export const DEVELOPMENT_ENVIRONMENTS = ['local', 'test', 'development'] as const;
