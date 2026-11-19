/**
 * Validated server-side configuration for apps/web, loaded through @chronos/config so the app
 * refuses to start with invalid values. Server-only: never import this from a Client Component.
 *
 * The browser bundle needs no configuration. It talks to the gateway through the same-origin
 * `/api/graphql` rewrite (next.config.ts), so session cookies stay first-party and the CSP can
 * keep `connect-src 'self'`.
 */
import { httpUrl, loadConfigOrExit, logLevel, nodeEnv } from '@chronos/config';
import { z } from 'zod';

const webSchema = z.object({
  NODE_ENV: nodeEnv,
  SERVICE_NAME: z.string().min(1).default('web'),
  LOG_LEVEL: logLevel.default('info'),

  /** GraphQL gateway URL, used by Server Components and the /api/graphql rewrite. */
  GATEWAY_URL: httpUrl.default('http://localhost:4000/graphql'),
});

export type WebConfig = z.infer<typeof webSchema>;

export const config: WebConfig = loadConfigOrExit(webSchema);
