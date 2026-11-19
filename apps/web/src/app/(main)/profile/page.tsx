import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfilePage() {
  return (
    <section className="p-4">
      <h1 className="text-xl font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        Profile
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Profile editing will be available in M1.5.</p>
    </section>
  );
}
