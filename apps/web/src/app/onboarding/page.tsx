import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Finish signing up' };

/**
 * Where a new member lands after the code check. The onboarding steps themselves (terms and
 * privacy, then date of birth; ADR-0020) are built in M1.7.
 */
export default function OnboardingPage() {
  return (
    <main id="main-content" className="mx-auto max-w-md p-6">
      <h1 className="mb-3 text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
        You&apos;re signed in
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        Next, we&apos;ll ask you to accept the terms and privacy policy and confirm your date of
        birth. This part of sign-up is coming soon.
      </p>
    </main>
  );
}
