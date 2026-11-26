/**
 * The member's health profile (TASKS M2.8). Neutral tab title and path (ADR-0017, M1.9), screen
 * protection, and served per request with Cache-Control: no-store (ADR-0009), so no browser, proxy
 * or back/forward cache keeps a copy.
 */
import type { Metadata } from 'next';
import { HealthProfile } from '@/components/health/HealthProfile';
import { COPY } from '@/components/health/health-copy';
import { ScreenProtect } from '@/components/health/ScreenProtect';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // Neutral: tab titles and history must not imply health.
  title: 'Private',
  robots: { index: false, follow: false },
};

export default function HealthProfilePage() {
  return (
    <main id="main-content" className="mx-auto max-w-lg p-4">
      <ScreenProtect>
        <h1 className="mb-2 text-2xl font-semibold">{COPY.heading}</h1>
        <p className="mb-6" style={{ color: 'var(--color-text-muted)' }}>
          {COPY.intro}
        </p>
        <HealthProfile />
      </ScreenProtect>
    </main>
  );
}
