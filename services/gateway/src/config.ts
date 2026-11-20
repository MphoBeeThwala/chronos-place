import { flag, redisUrl } from '@chronos/config';
import { z } from 'zod';

/** The gateway's own settings, merged with the kit's. */
export const gatewayConfig = {
  /** Refresh locks across replicas now; rate limits next (ADR-0021). */
  REDIS_URL: redisUrl,
  /** host:port of the identity service's gRPC API. */
  IDENTITY_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50052'),
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
