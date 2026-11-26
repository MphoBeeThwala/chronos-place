import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Your account is being deleted' };

/** Shown after deletion starts. Public: the member is signed out by then. */
export default function AccountDeletedPage() {
  return (
    <main id="main-content" className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Your account is being deleted</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        You have been signed out everywhere and your profile is no longer shown. Everything else
        will be deleted within 30 days. Thank you for being part of Chronos Place.
      </p>
      <p>
        <Link href="/" className="touch-target inline-flex items-center underline">
          Go to the home page
        </Link>
      </p>
    </main>
  );
}
