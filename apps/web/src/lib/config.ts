/**
 * Validated environment configuration for apps/web.
 * Read via @chronos/config — never access process.env directly.
 *
 * NEXT_PUBLIC_* variables are exposed to the browser bundle.
 * Everything else is server-only.
 */
import { loadConfigOrExit } from '@chronos/config';
import { z } from 'zod';

const webSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('web'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  AWS_REGION: z.string().default('af-south-1'),

  /** GraphQL gateway URL (server-side – never exposed to the browser). */
  GATEWAY_URL: z.string().url().default('http://localhost:4000/graphql'),

  /** Public base URL of the web app (used for OG tags, redirects). */
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  /** Public media CDN base URL (CloudFront). */
  NEXT_PUBLIC_MEDIA_CDN: z.string().url().default('http://localhost:8333'),
});

export type WebConfig = z.infer<typeof webSchema>;

/**
 * Config is loaded once at module load time.
 * In Next.js, this runs in the Node.js process (not the browser).
 */
export const config: WebConfig = loadConfigOrExit(webSchema, {
  env: process.env as Record<string, string>,
});
