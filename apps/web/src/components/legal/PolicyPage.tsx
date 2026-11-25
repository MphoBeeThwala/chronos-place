import Link from 'next/link';
import type { PolicyDocument } from '@/legal/policies';
import { PolicyBlocks } from '@/legal/policy-blocks';

/** A policy page, readable without signing in, showing the text counsel approved. */
export function PolicyPage({ policy }: { policy: PolicyDocument }) {
  const muted = { color: 'var(--color-text-muted)' };
  return (
    <main id="main-content" className="mx-auto max-w-3xl p-6">
      <h1 className="mb-2 text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
        {policy.title}
      </h1>
      <p className="mb-6 text-sm" style={muted}>
        Version {policy.version}. Effective and approved {policy.approvedOn}.
      </p>
      <div className="space-y-4 leading-relaxed" style={{ color: 'var(--color-text)' }}>
        <PolicyBlocks blocks={policy.blocks} />
      </div>
      <p className="mt-10">
        <Link href="/" className="underline touch-target inline-flex items-center">
          Back to Chronos Place
        </Link>
      </p>
    </main>
  );
}
