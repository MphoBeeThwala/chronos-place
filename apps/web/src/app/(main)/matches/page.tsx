import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Matches' };

export default function MatchesPage() {
  return (
    <section className="p-4">
      <h1 className="text-xl font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        Matches
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        Your matches will appear here once M3 (matching service) is complete.
      </p>
    </section>
  );
}
