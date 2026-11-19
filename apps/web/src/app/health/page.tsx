/**
 * Health profile page.
 * Protected: screenshot prevention (web equivalent of FLAG_SECURE — CSS user-select: none
 * plus a printed-page warning). The ScreenProtect component handles this.
 * M2.8 will add the full health profile UX.
 */
import type { Metadata } from 'next';
import { ScreenProtect } from '@/components/health/ScreenProtect.js';

export const metadata: Metadata = {
  title: 'Health profile',
  // Instruct crawlers/caches not to index health-related pages.
  robots: { index: false, follow: false },
};

export default function HealthProfilePage() {
  return (
    <ScreenProtect>
      <main id="main-content" className="p-4 max-w-lg mx-auto">
        <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
          Health profile
        </h1>
        <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
          This information is encrypted and only shared with people you choose.
        </p>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Full health profile management will be available in M2.8.
        </p>
      </main>
    </ScreenProtect>
  );
}
