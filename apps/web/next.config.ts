import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  // Strict mode for catching React lifecycle issues early.
  reactStrictMode: true,

  // next-intl handles locale routing via middleware.
  // No default locale prefix on URLs — /feed not /en/feed.

  // Security headers.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
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
              "img-src 'self' data: blob: https:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
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

  // Suppress powered-by header.
  poweredByHeader: false,

  // Compiler-level rules.
  compiler: {
    // Remove console.* in production — we use @chronos/logger.
    removeConsole: process.env['NODE_ENV'] === 'production',
  },
};

export default withNextIntl(config);
