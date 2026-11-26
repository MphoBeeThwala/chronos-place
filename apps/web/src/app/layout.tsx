/**
 * Root layout — wraps every page.
 * Sets HTML lang, theme, fonts, global styles, skip-link, and providers.
 */
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { NONCE_HEADER } from '@/lib/csp';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getLocale } from 'next-intl/server';
import '@/styles/globals.css';
import { ThemeScript } from '@/components/layout/ThemeScript';
import { ApolloWrapper } from '@/components/layout/ApolloWrapper';
import { IdleTimeout } from '@/components/safety/IdleTimeout';
import { QuickExit } from '@/components/safety/QuickExit';

export const metadata: Metadata = {
  title: {
    default: 'Chronos Place',
    template: '%s — Chronos Place',
  },
  // Neutral: link previews and history show this (ADR-0017, TASKS M1.9).
  description: 'Dating and connection, on your terms.',
  robots: { index: false, follow: false }, // No indexing until public launch.
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf2ea' },
    { media: '(prefers-color-scheme: dark)', color: '#1e1119' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Inline theme script: runs before paint to prevent flash of wrong theme. */}
        <ThemeScript nonce={nonce} />
      </head>
      <body>
        {/* Skip-to-content for keyboard / screen-reader users (WCAG 2.4.1). */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        <NextIntlClientProvider messages={messages}>
          <ApolloWrapper nonce={nonce}>{children}</ApolloWrapper>
          {/* Safety controls on every screen (ADR-0017, TASKS M1.9). */}
          <QuickExit />
          <IdleTimeout />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
