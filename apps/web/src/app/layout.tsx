/**
 * Root layout — wraps every page.
 * Sets HTML lang, theme, fonts, global styles, skip-link, and providers.
 */
import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getLocale } from 'next-intl/server';
import '@/styles/globals.css';
import { ThemeScript } from '@/components/layout/ThemeScript';
import { ApolloWrapper } from '@/components/layout/ApolloWrapper';

export const metadata: Metadata = {
  title: {
    default: 'Chronos Place',
    template: '%s — Chronos Place',
  },
  description: 'A connection platform for people living with or beyond chronic health conditions.',
  robots: { index: false, follow: false }, // No indexing until public launch.
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#d946ef' },
    { media: '(prefers-color-scheme: dark)', color: '#a21caf' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Inline theme script: runs before paint to prevent flash of wrong theme. */}
        <ThemeScript />
      </head>
      <body>
        {/* Skip-to-content for keyboard / screen-reader users (WCAG 2.4.1). */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        <NextIntlClientProvider messages={messages}>
          <ApolloWrapper>{children}</ApolloWrapper>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
