import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const GATEWAY_GRAPHQL = process.env['GATEWAY_URL'] ?? 'http://localhost:4000/graphql';

/** The only route that may use the camera (ADR-0017, ADR-0022). */
export const CAMERA_ROUTE = '/verify';
/** The only route that may ask for location, for "show my approximate distance" (ADR-0023). */
export const LOCATION_ROUTE = '/onboarding';
const PERMISSIONS = (camera: string, geolocation = '()') =>
  `camera=${camera}, microphone=(), geolocation=${geolocation}`;

/**
 * Where photo uploads go and photos are served from (ADR-0024): the browser PUTs to a signed
 * link on this origin and loads images from it. Read at build time, like the other headers.
 * Development defaults to local SeaweedFS; production builds must set STORAGE_ORIGIN, or photo
 * uploads are blocked by the CSP.
 */
function storageOrigin(): string | undefined {
  const value =
    process.env['STORAGE_ORIGIN'] ??
    (process.env['NODE_ENV'] === 'production' ? undefined : 'http://127.0.0.1:8333');
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('STORAGE_ORIGIN must be https outside local development');
  }
  return url.origin;
}
const STORAGE = storageOrigin();

const config: NextConfig = {
  // Strict mode for catching React lifecycle issues early.
  reactStrictMode: true,

  // next-intl handles locale routing via middleware.
  // No default locale prefix on URLs — /feed not /en/feed.

  // Security headers.
  headers() {
    return Promise.resolve([
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: PERMISSIONS('()') },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            // Health pages add a stricter CSP at the route level.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'", // Next.js needs unsafe-inline for hydration chunks in dev
              "style-src 'self' 'unsafe-inline'",
              `img-src 'self' data: blob: https:${STORAGE ? ` ${STORAGE}` : ''}`,
              "font-src 'self'",
              `connect-src 'self'${STORAGE ? ` ${STORAGE}` : ''}`,
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
      {
        // Later entries override earlier ones for the same header: the camera opens here only.
        source: CAMERA_ROUTE,
        headers: [{ key: 'Permissions-Policy', value: PERMISSIONS('(self)') }],
      },
      {
        source: LOCATION_ROUTE,
        headers: [{ key: 'Permissions-Policy', value: PERMISSIONS('()', '(self)') }],
      },
    ]);
  },

  // The browser calls the gateway through this same-origin path, so the session cookie stays
  // first-party and the CSP keeps connect-src 'self'. GATEWAY_URL is validated at runtime by
  // src/lib/config.ts; this default only applies to local development.
  rewrites() {
    return Promise.resolve([
      { source: '/api/graphql', destination: GATEWAY_GRAPHQL },
      {
        // Selfie captures (ADR-0022), on the same gateway as GraphQL.
        source: '/api/verification/capture',
        destination: GATEWAY_GRAPHQL.replace(/\/graphql$/, '/verification/capture'),
      },
    ]);
  },

  // Image optimisation — only allow our own media CDN and local.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.cloudfront.net',
        pathname: '/**',
      },
    ],
  },

  // Lint and typecheck run as their own CI steps (pnpm lint, pnpm typecheck) with the repository
  // config, including the restricted-zone boundary rule; the build does not repeat them.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  // Suppress powered-by header.
  poweredByHeader: false,

  // Compiler-level rules.
  compiler: {
    // Remove console.* in production — we use @chronos/logger.
    removeConsole: process.env['NODE_ENV'] === 'production',
  },
};

export default withNextIntl(config);
