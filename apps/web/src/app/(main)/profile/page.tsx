import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfilePage() {
  return (
    <section className="p-4">
      <h1 className="text-xl font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        Profile
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Profile editing will be available in M1.5.</p>
      <p className="mt-4">
        <Link href="/verify" className="underline touch-target inline-flex items-center">
          Verify your profile with a selfie
        </Link>
      </p>
    </section>
  );
}
