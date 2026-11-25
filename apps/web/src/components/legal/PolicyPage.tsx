import Link from 'next/link';
import type { PolicyDocument } from '@/legal/policies';

/** A policy page, readable without signing in. */
export function PolicyPage({ policy }: { policy: PolicyDocument }) {
  const muted = { color: 'var(--color-text-muted)' };
  return (
    <main id="main-content" className="mx-auto max-w-2xl p-6">
      <h1 className="mb-2 text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
        {policy.title}
      </h1>
      <p className="mb-6 text-sm" style={muted}>
        Version {policy.version}, approved {policy.approvedOn}.
      </p>
      {policy.text ? (
        <div className="space-y-4" style={{ color: 'var(--color-text)' }}>
          {policy.text.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      ) : (
        <p
          role="note"
          className="rounded-lg px-4 py-3"
          style={{ backgroundColor: 'var(--color-bg-muted)', color: 'var(--color-text)' }}
        >
          Placeholder: the approved text of this policy has not been added to this build yet.
        </p>
      )}
      <p className="mt-8">
        <Link href="/" className="underline touch-target inline-flex items-center">
          Back to Chronos Place
        </Link>
      </p>
    </main>
  );
}
